import { and, eq, isNull, sql } from "drizzle-orm";
import { mailboxes, mailboxCredentials, type SmtpSizeProbeCode } from "@trafficflow/db";
import {
  buildImapAuth, learnSmtpMaxSize, oauthSmtpEndpoint, verifySmtpLogin,
  type CredMetaAuth, type SmtpSizeCreds, type SmtpSizeDial, type SmtpSizeOutcome,
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
 * run, in a random order, each at most one SMTP login, and the number appears in the mailbox list
 * the compose form already reads. A route that dialled on demand would put a provider's TCP
 * handshake in front of a compose window, and a lazy dial inside `GET /mailboxes` would put one
 * per mailbox in front of every tab.
 *
 * ── AND THE PASS REMEMBERS THAT IT DIALLED, WHICH IS WHY THERE IS A COLUMN FOR IT ────────────
 *
 * `smtp_max_size_bytes IS NULL` cannot be the only filter, because a server that announces nothing
 * leaves it NULL for ever: such a mailbox was re-selected on every run, so a permanently silent
 * submission server cost a login a day, from this host, for the life of the account. Mail 0063
 * adds the two columns that end it — `smtp_size_probed_at` and `smtp_size_probe_code` — and the
 * selection below reads them as a backoff rather than as a terminal state. Nothing here ever gives
 * up: a silent server is asked again a month later, a refused one a week later, and the row goes
 * back to being due the moment its credentials change (the write is keyed to the credential stamp,
 * so a rotation leaves it unstamped) or the moment somebody re-enters a password, which writes the
 * column directly through the connect flow.
 *
 * THE STAMP IS THIS HOST'S ALONE. The sync host does not write it, deliberately: on the managed
 * deployment every dial from there fails on a blocked port, and a stamp from a host that cannot
 * reach submission would suppress the host that can — the back-fill would then converge on
 * "nothing is probeable" while the egress that works sat idle.
 */

/** How many mailboxes one scheduled pass may probe. */
export const SMTP_SIZE_BATCH = 8;

/**
 * The bound on one pass, and it is about the INVOCATION rather than about politeness.
 *
 * This host runs under a 60-second ceiling, and each probe is a full connect + STARTTLS + AUTH
 * against somebody else's server on the probe timeouts. Eight of those, serially, against a set of
 * servers that may all be slow, can exceed the invocation — and an invocation killed mid-probe
 * records nothing for the mailboxes it had not reached yet, which is survivable only because an
 * unstamped row is still due and the next run selects it again. Eight is chosen so the common case
 * finishes in a
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
  /**
   * WHICH ROW the secret came from, and WHEN that row was last written.
   *
   * The transport is part of the stamp, not decoration. Both rows are inserted with ONE timestamp
   * by the env-credential bootstrap, so a predicate that accepted either transport at that instant
   * would be satisfied by the UNROTATED imap row after the smtp row alone had been replaced — and
   * the write it was guarding would go through against credentials it never probed.
   */
  credentialsTransport: "imap" | "smtp";
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
 * returns the submission endpoint from the imap row's `meta.smtp` with NO static auth and the
 * token callback in `auth`, which `learnSmtpMaxSize` awaits into one access token and presents as
 * XOAUTH2 — the send path's own authentication, never the refresh token as a password.
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
  // So the accepted set is explicit: absent (`undefined`) or exactly `password` dials, `oauth2`
  // produces coordinates with a token callback the rule then declines, and ANYTHING ELSE is not
  // probed at all — `null` INCLUDED. A first pass at this wrote `!== undefined && !== null &&
  // !== "password"`, which reads as "absent in either spelling", and that is wrong here: an
  // untyped row and a row that stores JSON `null` are not the same claim, and an oauth-shaped row
  // whose `authType` came back `null` would have had its refresh token decrypted and sent as a
  // password — the exact leak this branch exists to close.
  const authType = imapMeta.authType;
  if (authType === "oauth2") {
    // ── THE SECRET IS THE REFRESH TOKEN, AND IT IS DECRYPTED FOR THE TOKEN CALLBACK ─────────
    //
    // This used to pass the empty string here, which was harmless only because the rule then
    // DECLINED to dial an oauth transport at all: the callback it built could never have fetched
    // anything. Now that the rule dials XOAUTH2, the callback must be the real one — the same
    // `deps.oauth.forMailbox(...)` factory `makeSendAdapter` binds, so the access-token cache, the
    // client resolution and the rotated-token write are the SEND's, not a second copy.
    //
    // `buildImapAuth` still owns the branch. It THROWS for an oauth row this deployment cannot
    // serve (a provider we do not speak, no token source wired), and that throw is caught by the
    // caller as an unreadable credential — one mailbox unprobed, nothing logged from the provider.
    const secret = await deps.keyProvider.decrypt(imapRow.secretEnc, imapRow.keyVersion);
    return {
      creds: {
        // No static auth in the coordinates: a bearer token is not transport state. See
        // `verifySmtpLogin`, which presents it at the AUTH step and nowhere else.
        ...oauthSmtpEndpoint(imapMeta.smtp),
        auth: buildImapAuth(imapMeta, secret, deps.oauth?.forMailbox(mailboxId)),
      },
      credentialsTransport: "imap",
      credentialsUpdatedAt: imapRow.updatedAt,
    };
  }
  if (authType !== undefined && authType !== "password") return undefined;

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
    // imap row the fallback borrows from. That is the row a rotation would touch, and NAMING it
    // is what stops the other row standing in for it.
    credentialsTransport: smtpRow ? "smtp" : "imap",
    credentialsUpdatedAt: (smtpRow ?? imapRow).updatedAt,
  };
}

/**
 * HOW LONG A SILENT SERVER IS LEFT ALONE — and it is a month rather than a day for a reason that
 * is about the server, not about politeness.
 *
 * "Silent" means the login completed and the EHLO named no usable `SIZE`. That is a statement about
 * the submission server's CONFIGURATION, and configurations do change (a provider raises a limit, an
 * administrator turns the extension on), so this is a backoff and never a terminal state. But it
 * changes on the timescale of a provider's release notes, not a day's, and every re-ask costs a real
 * login against somebody else's infrastructure.
 */
export const SMTP_SIZE_RETRY_SILENT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * HOW LONG A FAILED PROBE IS LEFT ALONE — shorter, because the cause is usually ours or the
 * account's rather than the server's.
 *
 * A refusal, an unreachable host, a token that could not be minted: each of those is a condition
 * somebody can fix, and the fix does not write this column. A week keeps a permanently broken
 * mailbox at about four logins a month (it was thirty) while still converging quickly once whatever
 * was wrong is repaired.
 *
 * The one case that needs no backoff at all is the common one: a person re-entering their password
 * re-dials SMTP inside the connect flow, which writes `smtp_max_size_bytes` directly. So the
 * ceiling after a repair is not gated on this interval — this interval only governs how often we
 * ask a server nobody has touched.
 */
export const SMTP_SIZE_RETRY_FAILED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * WHAT TO RECORD ABOUT ONE ATTEMPT, or `null` when nothing was attempted and the row must stay
 * exactly as due as it was.
 *
 * Total over `SmtpSizeOutcome` on purpose: the compiler is what keeps a future member of that union
 * from silently falling into "do not stamp", which is the direction that reintroduces the
 * dial-every-day defect. The failure codes pass STRAIGHT THROUGH — `SmtpSizeFailure` is a subset of
 * {@link SmtpSizeProbeCode} by construction — because the whole point of that type is that the value
 * came from our own classification of an error code and never from a server's prose.
 */
function probeCodeFor(res: SmtpSizeOutcome): SmtpSizeProbeCode | null {
  switch (res.outcome) {
    case "learned": return "learned";
    case "silent": return "silent";
    case "failed": return res.code;
    case "skipped":
      // `no_smtp_credentials` IS an outcome worth remembering: a mailbox with nothing to dial is
      // exactly the kind of row that was re-selected every single day. `already_attempted` is
      // unreachable from this pass (one row per id per batch) and would mean "somebody else already
      // stamped it".
      return res.reason === "no_smtp_credentials" ? "no_credentials" : null;
    // The column already holds an announcement, so the row was never selected and no dial happened.
    case "known": return null;
  }
}

export interface SmtpSizePassResult {
  /** How many rows the pass looked at. */
  considered: number;
  /** How many announcements were recorded. */
  learned: number;
  /** Dialled, and the server announced nothing usable. */
  silent: number;
  /**
   * Nothing to dial with. No credential row at all, an `authType` this build refuses, an envelope
   * this deployment cannot decrypt — but NOT an oauth transport any more: those are dialled with a
   * bearer token, and a mailbox whose token cannot be minted counts as `failed`.
   */
  skipped: number;
  /** The dial failed. Named per mailbox in the log, counted here. */
  failed: number;
  /**
   * How many rows carry a fresh attempt stamp because of this pass — the durable half of the
   * bound, and the only counter here that says anything about the NEXT pass.
   *
   * It is deliberately not equal to `considered`: a row whose credentials rotated mid-dial is left
   * unstamped so it stays due, which is the one case where a probe happened and nothing was
   * remembered.
   */
  stamped: number;
}

/**
 * RECORD ONE ATTEMPT — the stamp, and the announcement when there is one, in a single statement.
 *
 * Returns whether the row was actually written, because "the probe happened" and "the row now
 * remembers it" are different facts and the second is the one that bounds the next pass.
 *
 * ── THE WRITE IS TIED TO THE CREDENTIALS THAT WERE PROBED ───────────────────────────────────
 *
 * `IS NULL` alone is not enough, and the case that breaks it is specific: a PATCH that installs NEW
 * credentials whose server advertises no usable `SIZE` deliberately writes `null` to
 * `smtp_max_size_bytes`. The row is therefore still NULL when this older, in-flight probe returns —
 * so an `IS NULL`-only predicate would store the PREVIOUS server's limit against the new
 * credentials, which is a ceiling for a server this mailbox no longer sends through.
 *
 * The credential row's `updated_at` as it stood BEFORE the dial closes it: a rotation moves that
 * stamp, so the update matches nothing, the newer measurement stands — AND the row stays unstamped,
 * which is what puts it back in the next pass's selection. That is the intended reading of a
 * rotation: the credentials changed, so what we learned about the old ones is not an answer about
 * this mailbox any more.
 *
 * THE TRANSPORT IS PART OF THE PREDICATE. `IN ('smtp','imap')` was not enough: the env bootstrap
 * writes both rows with one timestamp, so at that value the untouched imap row satisfies a
 * transport-blind check even after the smtp row alone has been rotated — and the guard would pass
 * in exactly the case it exists to catch.
 *
 * `announced` is passed only for a learned outcome. A `null` here would MEAN something (the connect
 * flow writes it to say "this server states no ceiling"), so it is an absent property rather than an
 * explicit null: nothing in this pass may clear a number another writer put there.
 */
async function stampProbe(
  deps: ApiDeps,
  mailboxId: string,
  code: SmtpSizeProbeCode,
  target: ProbeTarget | undefined,
  at: Date,
  announced?: number,
): Promise<boolean> {
  const rows = await deps.db.update(mailboxes)
    .set({
      ...(announced === undefined ? {} : { smtpMaxSizeBytes: announced }),
      smtpSizeProbedAt: at,
      smtpSizeProbeCode: code,
    })
    .where(and(
      eq(mailboxes.id, mailboxId),
      isNull(mailboxes.smtpMaxSizeBytes),
      ...(target
        ? [sql`EXISTS (
            SELECT 1 FROM mailbox_credentials mc
            WHERE mc.mailbox_id = ${mailboxId}
              AND mc.transport = ${target.credentialsTransport}
              AND mc.updated_at = ${target.credentialsUpdatedAt}
          )`]
        : []),
    ))
    // `.returning()` rather than a row count, because the handle this pass runs on is typed as the
    // narrow transaction seam and a driver-specific `rowCount` is not on it. It is one row at most.
    .returning();
  return rows.length > 0;
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
 * process: carrying it across would need state this host does not keep. What stops a re-dial ACROSS
 * invocations is the durable stamp (mail 0063) the selection reads and the loop writes.
 */
export async function learnMissingSmtpSizes(
  deps: ApiDeps,
  opts: { dial?: SmtpSizeDial; now?: () => Date } = {},
): Promise<SmtpSizePassResult> {
  const dial = opts.dial ?? apiSmtpSizeDial;
  const now = opts.now ?? ((): Date => new Date());
  // ONE clock read for the whole selection: the deadline's origin and both backoff cutoffs are the
  // same instant by construction, so no interleaving can make a row "due" against one and not the
  // other. The per-mailbox deadline check below reads the clock again, which is the point of it.
  const startedAt = now();
  const started = startedAt.getTime();
  // ── THE SELECTION HAS TO CONVERGE, AND `IS NULL` ALONE DOES NOT ────────────────────────────
  //
  // A row stays NULL whenever the answer is "nothing to record": a server that advertises no
  // `SIZE`, a login the server refuses, a mailbox with nothing to dial. A selection keyed on
  // `IS NULL` alone therefore re-selects exactly those rows every pass, for ever — and once as
  // many of them exist as the batch holds, no other mailbox is ever reached again. The rows that
  // CAN be learned starve behind the rows that cannot, and the ones that cannot get dialled on
  // every run of the schedule.
  //
  // Three things fix that, and only the third is durable:
  //
  //  · THE ORDER IS RANDOM, not oldest-first. Nothing about this pass wants a stable order — it is
  //    a back-fill, not a queue — and a rotation cannot starve a subset the way a fixed order can:
  //    every eligible row is reached in expectation, whatever sticks.
  //  · THE BATCH AND THE DEADLINE bound one invocation.
  //  · THE ATTEMPT STAMP (mail 0063) bounds the SEQUENCE of invocations, which is the only one of
  //    the three that a permanently silent server cannot outlast. A stamped row is not due again
  //    until its backoff has passed — {@link SMTP_SIZE_RETRY_SILENT_MS} for a server that answered
  //    and named nothing, {@link SMTP_SIZE_RETRY_FAILED_MS} for everything else — so a mailbox
  //    nobody can learn costs at most a login a month instead of one a day, and the finite backlog
  //    of learnable rows drains behind it either way.
  //
  // OAUTH IS NO LONGER EXCLUDED. It used to be, in this very predicate, because the rule declined
  // to dial a transport it had no password for and selecting such a row only ever spent a slot.
  // Now that the rule presents XOAUTH2 with the token the send path mints, an oauth mailbox is
  // exactly as probeable as any other — and it was the one class of mailbox that could never learn
  // its ceiling from any host at all.
  //
  // `COALESCE` on the code, not `= 'silent'` bare: a stamped row whose code was somehow NULL would
  // otherwise satisfy neither arm and never be due again, turning a backoff into the terminal state
  // this design refuses to have.
  const silentCutoff = new Date(started - SMTP_SIZE_RETRY_SILENT_MS);
  const failedCutoff = new Date(started - SMTP_SIZE_RETRY_FAILED_MS);
  const rows = await deps.db.select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(
      isNull(mailboxes.smtpMaxSizeBytes),
      sql`${mailboxes.status} <> 'disabled'`,
      sql`(
        ${mailboxes.smtpSizeProbedAt} IS NULL
        OR (COALESCE(${mailboxes.smtpSizeProbeCode}, 'unknown') = 'silent'
              AND ${mailboxes.smtpSizeProbedAt} <= ${silentCutoff})
        OR (COALESCE(${mailboxes.smtpSizeProbeCode}, 'unknown') <> 'silent'
              AND ${mailboxes.smtpSizeProbedAt} <= ${failedCutoff})
      )`,
    ))
    .orderBy(sql`random()`)
    .limit(SMTP_SIZE_BATCH);

  const out: SmtpSizePassResult = {
    considered: 0, learned: 0, silent: 0, skipped: 0, failed: 0, stamped: 0,
  };
  const attempted = new Set<string>();
  for (const row of rows) {
    // The deadline, checked between mailboxes rather than inside one: a probe already in flight has
    // a timeout of its own, and abandoning it would leave the socket to be collected.
    if (now().getTime() - started > SMTP_SIZE_DEADLINE_MS) break;
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
      // STAMPED WITHOUT A CREDENTIAL PREDICATE, unlike every other write in this loop, because
      // there is no credential this attempt can name — the resolution threw before it produced one.
      // A row here was re-selected every single day, so leaving it unstamped is the daily-forever
      // defect with an extra step. The cost is that a repaired envelope waits out the failed
      // backoff, and it is a cost the product does not actually pay: the repair a person performs
      // is re-entering a password, and that path writes `smtp_max_size_bytes` itself.
      if (await stampProbe(deps, row.id, "no_credentials", undefined, now())) out.stamped += 1;
      continue;
    }
    const res = await learnSmtpMaxSize({
      mailboxId: row.id, announced: null, smtp: target?.creds, attempted, dial,
    });
    if (res.outcome === "learned") {
      // COUNTED HERE, WRITTEN BELOW. The announcement's own conditional update — `IS NULL` plus the
      // credential stamp that was captured before the dial — moved into {@link stampProbe}, which
      // now performs one statement per attempt for every outcome; the reasoning for each conjunct
      // is on that function. This branch's job is the count and the log line.
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
    // ── ONE WRITE PER ATTEMPT, CARRYING BOTH WHAT WAS LEARNED AND THAT IT WAS ATTEMPTED ──────
    //
    // The announcement and the stamp go in the SAME statement under the SAME predicate, and that
    // is the property that makes the pair readable: there is no interleaving in which the row says
    // "probed, learned" while `smtp_max_size_bytes` is still NULL, or holds a number with no record
    // of the attempt that produced it.
    const code = probeCodeFor(res);
    if (code !== null
        && await stampProbe(deps, row.id, code, target, now(),
          res.outcome === "learned" ? res.maxMessageBytes : undefined)) {
      out.stamped += 1;
    }
  }
  return out;
}
