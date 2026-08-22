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
 * The coordinates to dial, PLUS the stamp of the credential row they came from.
 *
 * The stamp is what makes the write safe against a credential rotation that happens while the dial
 * is in flight — see {@link learnMissingSmtpSizes}. Carried out of the resolution rather than
 * re-read at the write, because the point is the value AS IT WAS WHEN PROBED.
 */
interface ProbeTarget {
  creds: SmtpSizeCreds;
  /** `mailbox_credentials.updated_at` of the row whose secret this dial will present. */
  credentialsUpdatedAt: Date;
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
async function smtpCredsFor(deps: ApiDeps, mailboxId: string): Promise<ProbeTarget | undefined> {
  const rows = await deps.db.select().from(mailboxCredentials)
    .where(eq(mailboxCredentials.mailboxId, mailboxId));
  const imapRow = rows.find((r) => r.transport === "imap");
  if (!imapRow) return undefined;
  const imapMeta = (imapRow.meta ?? {}) as CredMeta;

  // ── FAIL CLOSED ON THE AUTH TYPE, and the default branch is the whole point ────────────────
  //
  // This used to read `authType === "oauth2" ? … : password`, which means every OTHER value —
  // a future scheme, a corrupt row, a typo — fell into the password branch, where the secret is
  // decrypted and handed to `verifySmtpLogin` AS A PASSWORD. For an oauth-shaped row that secret
  // is a refresh token, so the fall-through was a path from the credential store to somebody
  // else's AUTH command. `buildImapAuth` throws on an unknown type for exactly this reason; this
  // resolution must not be the one place that does not.
  //
  // So the accepted set is explicit: absent or `password` dials, `oauth2` produces coordinates
  // with a token callback the rule then declines, and ANYTHING ELSE is not probed at all.
  const authType = imapMeta.authType;
  if (authType === "oauth2") {
    const s = imapMeta.smtp ?? {};
    // No static auth on purpose — see the note above. `buildImapAuth` hands back a token callback
    // here, and the rule's narrowing is what turns that into a skip.
    return {
      creds: {
        host: s.host ?? "smtp.office365.com",
        port: s.port ?? 587,
        secure: s.secure ?? false,
        auth: buildImapAuth(imapMeta, "", deps.oauth?.forMailbox(mailboxId)),
      },
      credentialsUpdatedAt: imapRow.updatedAt,
    };
  }
  if (authType !== undefined && authType !== null && authType !== "password") return undefined;

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
    creds: {
      host, port: smtpMeta.port ?? 587, secure: smtpMeta.secure ?? false,
      auth: { user, pass: secret },
    },
    // The row whose SECRET is being presented — the smtp row when there is one, otherwise the
    // imap row the fallback borrows from. That is the row a rotation would touch.
    credentialsUpdatedAt: (smtpRow ?? imapRow).updatedAt,
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
  // ── THE SELECTION HAS TO CONVERGE, AND OLDEST-FIRST DOES NOT ───────────────────────────────
  //
  // A row stays NULL whenever the answer is "nothing to record": an oauth transport, a server that
  // advertises no `SIZE`, a login the server refuses. Oldest-first therefore re-selects exactly
  // those rows every pass, for ever — and once as many of them exist as the batch holds, no other
  // mailbox is ever reached again. The rows that CAN be learned starve behind the rows that
  // cannot, and the ones that cannot get dialled on every run.
  //
  // Two changes, and neither is a durable marker:
  //
  //  · OAUTH IS EXCLUDED IN SQL. `learnSmtpMaxSize` declines those anyway (there is no password to
  //    present), so selecting them only ever spent a slot. Read off the imap credential row's
  //    `meta`, which is where the connect flow records the scheme.
  //  · THE ORDER IS RANDOM, not oldest-first. Nothing about this pass wants a stable order — it is
  //    a back-fill, not a queue — and a rotation cannot starve a subset the way a fixed order can:
  //    every eligible row is reached in expectation, whatever sticks.
  //
  // What this still does NOT do is stop re-dialling a server that answers nothing. Bounding that
  // properly needs a durable per-mailbox attempt stamp, which is a migration; the residual is
  // bounded instead by the batch and by the DAILY cadence, so a permanently silent server costs at
  // most one login a day and the finite backlog still drains. The stamp is the named follow-up.
  const rows = await deps.db.select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(
      isNull(mailboxes.smtpMaxSizeBytes),
      sql`${mailboxes.status} <> 'disabled'`,
      sql`NOT EXISTS (
        SELECT 1 FROM mailbox_credentials mc
        WHERE mc.mailbox_id = ${mailboxes.id}
          AND mc.transport = 'imap'
          AND mc.meta ->> 'authType' = 'oauth2'
      )`,
    ))
    .orderBy(sql`random()`)
    .limit(SMTP_SIZE_BATCH);

  const out: SmtpSizePassResult = { considered: 0, learned: 0, silent: 0, skipped: 0, failed: 0 };
  const attempted = new Set<string>();
  for (const row of rows) {
    // The deadline, checked between mailboxes rather than inside one: a probe already in flight has
    // a timeout of its own, and abandoning it would leave the socket to be collected.
    if ((opts.now ?? (() => new Date()))().getTime() - started > SMTP_SIZE_DEADLINE_MS) break;
    out.considered += 1;
    let target: ProbeTarget | undefined;
    try {
      target = await smtpCredsFor(deps, row.id);
    } catch {
      // A credential envelope this deployment cannot decrypt is one mailbox's problem. The reason
      // is NOT logged: a decryption failure's message is about key material, and this line already
      // says which mailbox to go and look at.
      deps.logger?.info("smtp_size_creds_unreadable", { mailboxId: row.id });
      out.skipped += 1;
      continue;
    }
    const res = await learnSmtpMaxSize({
      mailboxId: row.id, announced: null, smtp: target?.creds, attempted, dial,
    });
    if (res.outcome === "learned") {
      // ── THE WRITE IS TIED TO THE CREDENTIALS THAT WERE PROBED ─────────────────────────────
      //
      // `IS NULL` alone is not enough, and the case that breaks it is specific: a PATCH that
      // installs NEW credentials whose server advertises no usable `SIZE` deliberately writes
      // `null` to this column. The row is therefore still NULL when this older, in-flight probe
      // returns — so an `IS NULL`-only predicate would store the PREVIOUS server's limit against
      // the new credentials, which is a ceiling for a server this mailbox no longer sends through.
      //
      // The credential row's `updated_at` as it stood BEFORE the dial closes it: a rotation moves
      // that stamp, so the update matches nothing and the newer measurement stands.
      const stamp = target!.credentialsUpdatedAt;
      await deps.db.update(mailboxes)
        .set({ smtpMaxSizeBytes: res.maxMessageBytes })
        .where(and(
          eq(mailboxes.id, row.id),
          isNull(mailboxes.smtpMaxSizeBytes),
          sql`EXISTS (
            SELECT 1 FROM mailbox_credentials mc
            WHERE mc.mailbox_id = ${row.id}
              AND mc.transport IN ('smtp', 'imap')
              AND mc.updated_at = ${stamp}
          )`,
        ));
      out.learned += 1;
      // `announcedBytes`, not `maxMessageBytes`: the logger drops any field its census does not
      // name, and the census is where a field earns the right to be emitted. See `log.ts`.
      deps.logger?.info("smtp_size_learned", {
        mailboxId: row.id, announcedBytes: res.maxMessageBytes,
      });
    } else if (res.outcome === "silent") {
      out.silent += 1;
    } else if (res.outcome === "failed") {
      out.failed += 1;
      // A CLOSED CODE, never the server's own words — the message would be third-party text on a
      // path to a log drain. `SmtpSizeFailure` argues it where the classification happens.
      deps.logger?.info("smtp_size_unlearned", { mailboxId: row.id, code: res.code });
    } else {
      out.skipped += 1;
    }
  }
  return out;
}
