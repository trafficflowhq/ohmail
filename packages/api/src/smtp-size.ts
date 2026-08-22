import { and, eq, isNull, sql } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import {
  buildImapAuth, learnSmtpMaxSize, verifySmtpLogin,
  type CredMetaAuth, type SmtpSizeCreds, type SmtpSizeDial,
} from "@trafficflow/core/adapters/imap";
import { PROBE_TIMEOUTS } from "./imap-probe.js";
import type { ApiDeps } from "./deps.js";

/**
 * ══ THE API HOST'S HALF of the `SIZE` back-fill ═══════════════════════════════════════════════
 *
 * `mailboxes.smtp_max_size_bytes` is the only ceiling left on an attachment once the bytes stop
 * riding the send request, and nothing ever learned it for a mailbox that was already connected:
 * the column is written when a mailbox is created with an SMTP block and when a PATCH re-dials
 * SMTP — which means the person re-entering their password. Every mailbox older than the column
 * therefore announced nothing for ever and stayed pinned to the strict product constant.
 *
 * ── WHY THIS RUNS HERE AND NOT ON THE SYNC HOST, WHICH IS MEASURED ──────────────────────────
 *
 * The sync worker is the obvious home — it already walks every mailbox with these credentials
 * decrypted — and on the managed deployment it CANNOT do it, which was measured rather than
 * assumed: a dozen different submission hosts, every one answering `Connection timeout`, while an
 * IMAP dial to the same host on 993 completed in about 300 ms in the very next log line. That
 * platform blocks outbound submission ports.
 *
 * This host does not have that problem, and the proof is the product: every send dials SMTP from
 * here, and the connect-time probe that populates this column for a NEW mailbox is this host's too.
 * So the back-fill for existing mailboxes belongs on the same egress as the write that already
 * works. The worker's arm is kept for a self-hosted deployment whose egress is open.
 *
 * ── A SCHEDULED PASS, NOT A REQUEST PATH ────────────────────────────────────────────────────
 *
 * Nothing a person does waits on this. It is a bounded batch on a cron: a handful of mailboxes per
 * run, oldest-unknown first, each at most one SMTP login, and the number appears in the mailbox
 * list the compose form already reads. A route that dialled on demand would put a provider's TCP
 * handshake in front of a compose window, and a lazy dial inside `GET /mailboxes` would put one
 * per mailbox in front of every tab.
 */

/** How many mailboxes one scheduled pass may probe. */
export const SMTP_SIZE_BATCH = 8;

/**
 * The bound on one pass, and it is about the INVOCATION rather than about politeness.
 *
 * This host runs under a 60-second ceiling, and each probe is a full connect + STARTTLS + AUTH
 * against somebody else's server on the probe timeouts. Eight of those, serially, against a set of
 * servers that may all be slow, can exceed the invocation — and an invocation killed mid-probe
 * records nothing for the mailboxes it had not reached yet, which is survivable only because the
 * next run starts again from the oldest unknown. Eight is chosen so the common case finishes in a
 * few seconds and the pathological case is still cut off by the deadline below rather than by the
 * platform.
 */
export const SMTP_SIZE_DEADLINE_MS = 40_000;

/** The dial from this host: a real SMTP login on the TLS floor, on the connect probe's timeouts. */
export const apiSmtpSizeDial: SmtpSizeDial = (smtp) => verifySmtpLogin(smtp, PROBE_TIMEOUTS);

interface CredMeta extends CredMetaAuth {
  host?: string; port?: number; secure?: boolean;
  smtp?: { host?: string; port?: number; secure?: boolean };
}

/**
 * The SMTP coordinates this mailbox's send would use, decrypted — or `undefined` when there are
 * none to use.
 *
 * THE SAME RESOLUTION `makeSendAdapter` APPLIES, and it has to be: a probe that dialled a different
 * endpoint from the one the send will dial would record an announcement that is not about the
 * server the message goes to. The password branch prefers the dedicated `smtp` row and falls back
 * to the imap host and secret (the single-credential generic-IMAP convention); the oauth branch
 * returns coordinates with no static auth, which `learnSmtpMaxSize` then declines to dial rather
 * than sending a refresh token as a password.
 */
async function smtpCredsFor(deps: ApiDeps, mailboxId: string): Promise<SmtpSizeCreds | undefined> {
  const rows = await deps.db.select().from(mailboxCredentials)
    .where(eq(mailboxCredentials.mailboxId, mailboxId));
  const imapRow = rows.find((r) => r.transport === "imap");
  if (!imapRow) return undefined;
  const imapMeta = (imapRow.meta ?? {}) as CredMeta;

  if (imapMeta.authType === "oauth2") {
    const s = imapMeta.smtp ?? {};
    // No static auth on purpose — see the note above. `buildImapAuth` would hand back a token
    // callback here, and the rule's narrowing is what turns that into a skip.
    return {
      host: s.host ?? "smtp.office365.com",
      port: s.port ?? 587,
      secure: s.secure ?? false,
      auth: buildImapAuth(imapMeta, "", deps.oauth?.forMailbox(mailboxId)),
    };
  }

  const smtpRow = rows.find((r) => r.transport === "smtp");
  const smtpMeta = smtpRow ? ((smtpRow.meta ?? {}) as CredMeta) : {
    host: imapMeta.host, port: 587, secure: false, user: imapMeta.user,
  } as CredMeta;
  const secret = smtpRow
    ? await deps.keyProvider.decrypt(smtpRow.secretEnc, smtpRow.keyVersion)
    : await deps.keyProvider.decrypt(imapRow.secretEnc, imapRow.keyVersion);
  const user = smtpMeta.user ?? imapMeta.user ?? "";
  const host = smtpMeta.host ?? imapMeta.host ?? "";
  if (host === "" || user === "") return undefined;
  return {
    host, port: smtpMeta.port ?? 587, secure: smtpMeta.secure ?? false,
    auth: { user, pass: secret },
  };
}

export interface SmtpSizePassResult {
  /** How many rows the pass looked at. */
  considered: number;
  /** How many announcements were recorded. */
  learned: number;
  /** Dialled, and the server announced nothing usable. */
  silent: number;
  /** No password to dial with — an oauth transport, or no credentials at all. */
  skipped: number;
  /** The dial failed. Named per mailbox in the log, counted here. */
  failed: number;
}

/**
 * One scheduled pass: probe up to {@link SMTP_SIZE_BATCH} mailboxes that have never announced a
 * `SIZE`, and record what each server says.
 *
 * DISABLED mailboxes are excluded. A disabled row cannot send, so its ceiling answers no question
 * anybody is asking, and dialling it would spend a login on a mailbox whose credentials may
 * since have been retired.
 *
 * The `attempted` set is per PASS rather than per process, because a serverless invocation IS the
 * process: carrying it across would need state this host does not keep. The `IS NULL` filter is
 * what actually stops a re-dial, so a server that announces nothing is re-probed on a later pass —
 * bounded by the batch size and by there being only so many such mailboxes.
 */
export async function learnMissingSmtpSizes(
  deps: ApiDeps,
  opts: { dial?: SmtpSizeDial; now?: () => Date } = {},
): Promise<SmtpSizePassResult> {
  const dial = opts.dial ?? apiSmtpSizeDial;
  const started = (opts.now ?? (() => new Date()))().getTime();
  const rows = await deps.db.select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(isNull(mailboxes.smtpMaxSizeBytes), sql`${mailboxes.status} <> 'disabled'`))
    .orderBy(mailboxes.createdAt)
    .limit(SMTP_SIZE_BATCH);

  const out: SmtpSizePassResult = { considered: 0, learned: 0, silent: 0, skipped: 0, failed: 0 };
  const attempted = new Set<string>();
  for (const row of rows) {
    // The deadline, checked between mailboxes rather than inside one: a probe already in flight has
    // a timeout of its own, and abandoning it would leave the socket to be collected.
    if ((opts.now ?? (() => new Date()))().getTime() - started > SMTP_SIZE_DEADLINE_MS) break;
    out.considered += 1;
    let creds: SmtpSizeCreds | undefined;
    try {
      creds = await smtpCredsFor(deps, row.id);
    } catch (err) {
      // A credential envelope this deployment cannot decrypt is one mailbox's problem.
      deps.logger?.info("smtp_size_creds_unreadable", {
        mailboxId: row.id, reason: err instanceof Error ? err.message : String(err),
      });
      out.skipped += 1;
      continue;
    }
    const res = await learnSmtpMaxSize({
      mailboxId: row.id, announced: null, smtp: creds, attempted, dial,
    });
    if (res.outcome === "learned") {
      // ONLY over a row that still announces nothing: a PATCH that re-dialled in the meantime is a
      // more recent measurement by the ceremony that owns this column.
      await deps.db.update(mailboxes)
        .set({ smtpMaxSizeBytes: res.maxMessageBytes })
        .where(and(eq(mailboxes.id, row.id), isNull(mailboxes.smtpMaxSizeBytes)));
      out.learned += 1;
      deps.logger?.info("smtp_size_learned", {
        mailboxId: row.id, maxMessageBytes: res.maxMessageBytes,
      });
    } else if (res.outcome === "silent") {
      out.silent += 1;
    } else if (res.outcome === "failed") {
      out.failed += 1;
      deps.logger?.info("smtp_size_unlearned", { mailboxId: row.id, reason: res.error });
    } else {
      out.skipped += 1;
    }
  }
  return out;
}
