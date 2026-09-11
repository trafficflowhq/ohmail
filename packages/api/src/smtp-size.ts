import { and, eq, exists, isNull, lte, or, sql } from "drizzle-orm";
import { mailboxes, mailboxCredentials, type SmtpSizeProbeCode } from "@trafficflow/db";
import {
  buildImapAuth, learnSmtpMaxSize, oauthSmtpEndpoint, verifySmtpLogin,
  type CredMetaAuth, type SmtpSizeCreds, type SmtpSizeDial, type SmtpSizeOutcome,
} from "@trafficflow/core/adapters/imap";
import { PROBE_TIMEOUTS } from "./imap-probe.js";
import type { ApiDeps } from "./deps.js";

/**
 * The API host's half of the `SIZE` back-fill. `smtp_max_size_bytes` is the only ceiling left
 * once bytes stop riding the send request, and nothing learned it for an already-connected
 * mailbox. Here, not the sync host, measured: that platform blocks outbound submission ports;
 * this host dials SMTP on every send. A scheduled pass: a bounded random batch per cron. The pass
 * remembers that it dialled: `IS NULL` alone re-selects silent servers forever, so mail 0063's
 * columns are a backoff, never terminal — due again when the backoff passes, the credentials
 * change, or a password re-entry writes the column. The stamp is this host's alone: one from a
 * host that cannot reach submission would suppress the one that can.
 */

/** How many mailboxes one scheduled pass may probe. */
export const SMTP_SIZE_BATCH = 8;

/**
 * The bound on one pass, about the invocation rather than politeness: this host runs under a
 * 60-second ceiling, and each probe is a full connect + STARTTLS + AUTH against somebody else's
 * server. Eight of those, serially, against slow servers can exceed the invocation — and an
 * invocation killed mid-probe records nothing for the mailboxes it had not reached, survivable
 * only because an unstamped row is still due next run. Eight keeps the common case at a few
 * seconds; the pathological case is cut off by the deadline below rather than by the platform.
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
/**
 * EXPORTED FOR ONE REASON: the real-Postgres guard drives {@link stampProbe} directly.
 *
 * The pass's selection is fleet-wide and randomly ordered, so no test can steer a batch onto a row
 * it seeded in a shared database — which means the concurrency question this write exists to answer
 * ("does a genuinely concurrent, genuinely COMMITTED credential write change what this statement
 * matches?") is unreachable through `learnMissingSmtpSizes` there. Exporting the write lets that
 * question be asked against the statement itself, with a second connection and a real commit
 * barrier, instead of against a restatement of it.
 */
export interface ProbeTarget {
  creds: SmtpSizeCreds;
  /**
   * Which row the secret came from, and what about it the write may depend on. The transport is
   * part of the guard: the env bootstrap inserts both rows with one timestamp, so a
   * transport-blind predicate is satisfied by the unrotated imap row after the smtp row alone was
   * replaced. The branches differ because one moves its own row: `stamp` is `updated_at` before
   * the dial — right when the secret is the credential. `meta` is the non-secret half, the oauth
   * guard: that row's `updated_at` is moved by the probe itself — a rotated refresh token made
   * the guard read its own side effect as somebody else's rotation and discard the measurement.
   * An announcement is about the endpoint and the identity.
   */
  credentialsTransport: "imap" | "smtp";
  credentialsGuard:
    | { kind: "stamp"; updatedAt: Date }
    | { kind: "meta"; meta: unknown; updatedAt: Date };
}

/**
 * The SMTP coordinates this mailbox's send would use, decrypted — or `undefined` when there are
 * none. The same resolution `makeSendAdapter` applies, and it has to be: a probe that dialled a
 * different endpoint from the one the send will dial records an announcement about the wrong
 * server. The password branch prefers the dedicated `smtp` row and falls back to the imap host
 * and secret; the oauth branch returns the submission endpoint from the imap row's `meta.smtp`
 * with no static auth and the token callback in `auth`, which `learnSmtpMaxSize` awaits into one
 * access token and presents as XOAUTH2 — the send path's own authentication, never the refresh
 * token as a password.
 */
async function smtpCredsFor(deps: ApiDeps, mailboxId: string): Promise<ProbeTarget | undefined> {
  const rows = await deps.db.select().from(mailboxCredentials)
    .where(eq(mailboxCredentials.mailboxId, mailboxId));
  const imapRow = rows.find((r) => r.transport === "imap");
  if (!imapRow) return undefined;
  const imapMeta = (imapRow.meta ?? {}) as CredMeta;

  // Fail closed on the auth type; the default branch is the point. This used to read `authType
  // === "oauth2" ? … : password`, so every other value — a future scheme, a corrupt row, a typo —
  // fell into the password branch, where the secret is decrypted and handed to `verifySmtpLogin`
  // as a password; for an oauth-shaped row that secret is a refresh token, a path from the
  // credential store to somebody else's AUTH command. The accepted set is explicit: absent
  // (`undefined`) or exactly `password` dials; `oauth2` produces coordinates with a token
  // callback; anything else — `null` included — is not probed at all. A first pass wrote `!==
  // undefined && !== null && !== "password"`, which reads as "absent in either spelling" and is
  // wrong here: an oauth row whose `authType` came back `null` would have had its refresh token
  // sent as a password — the exact leak this branch closes.
  const authType = imapMeta.authType;
  if (authType === "oauth2") {
    // The secret is the refresh token, decrypted for the token callback. This used to pass the
    // empty string, harmless only while the rule declined to dial oauth at all. Now that it dials
    // XOAUTH2, the callback must be the real one — the same `deps.oauth.forMailbox(...)` factory
    // `makeSendAdapter` binds, so the token cache, client resolution and rotated-token write are
    // the send's, not a second copy. `buildImapAuth` still owns the branch: it throws for an
    // oauth row this deployment cannot serve, and that throw is caught as an unreadable
    // credential — one mailbox unprobed, nothing logged from the provider.
    const secret = await deps.keyProvider.decrypt(imapRow.secretEnc, imapRow.keyVersion);
    return {
      creds: {
        // No static auth in the coordinates: a bearer token is not transport state. See
        // `verifySmtpLogin`, which presents it at the AUTH step and nowhere else.
        ...oauthSmtpEndpoint(imapMeta.smtp),
        auth: buildImapAuth(imapMeta, secret, deps.oauth?.forMailbox(mailboxId)),
      },
      credentialsTransport: "imap",
      // META, not `updated_at`: the token refresh this dial performs moves the row's stamp. See
      // {@link ProbeTarget.credentialsGuard}.
      credentialsGuard: { kind: "meta", meta: imapRow.meta, updatedAt: imapRow.updatedAt },
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
    // THE STAMP, for the password branch: here the secret IS the credential, so the row's own
    // `updated_at` is what a rotation moves and nothing in this path moves it by itself.
    credentialsGuard: { kind: "stamp", updatedAt: (smtpRow ?? imapRow).updatedAt },
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
 * How long a failed probe is left alone — shorter, because the cause is usually ours or the
 * account's rather than the server's: a refusal, an unreachable host, a token that could not be
 * minted are conditions somebody can fix, and the fix does not write this column. A week keeps a
 * permanently broken mailbox at about four logins a month (it was thirty) while converging
 * quickly once repaired. The common case needs no backoff at all: a person re-entering their
 * password re-dials SMTP inside the connect flow, which writes `smtp_max_size_bytes` directly —
 * this interval only governs how often we ask a server nobody has touched.
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
 * Record one attempt — the stamp, and the announcement when there is one, in one statement.
 * `exists()` and typed `eq`, never a raw fragment: a `Date` in a raw `sql` template reaches
 * postgres-js unmapped and throws; PGlite maps it silently. Returns whether the row was written.
 * The write is tied to the credentials probed — `IS NULL` alone breaks when a PATCH installs new
 * credentials whose server advertises no `SIZE`: the older in-flight probe's limit would land
 * against credentials it never probed. The transport is part of the predicate; an oauth row is
 * guarded on `meta` ({@link ProbeTarget.credentialsGuard}). `announced` only for a learned
 * outcome: nothing here may clear a number another writer put.
 */
export async function stampProbe(
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
        ? [exists(deps.db.select({ one: sql`1` }).from(mailboxCredentials).where(and(
            eq(mailboxCredentials.mailboxId, mailboxId),
            eq(mailboxCredentials.transport, target.credentialsTransport),
            target.credentialsGuard.kind === "stamp"
              ? eq(mailboxCredentials.updatedAt, target.credentialsGuard.updatedAt)
              // `jsonb = jsonb`, which is key-order-insensitive and so survives a round trip
              // through the driver. The captured value came out of this very column.
              : eq(mailboxCredentials.meta, target.credentialsGuard.meta),
            // And for one code, the stamp too. `token_unavailable` is the only outcome about the
            // credential rather than the server: no token could be minted from the refresh token
            // this pass read, and a concurrent rotation is a plausible cause — stamping would
            // back the mailbox off a week over a token since replaced. Every other outcome
            // followed a successful mint, proving the credential live; whatever the server then
            // did earns its stamp — the asymmetry keeps the common case (SMTP AUTH disabled) at
            // one login a week. `updated_at`, not `secret_enc`: a KEK rewrap re-encrypts the same
            // plaintext and leaves `updated_at` alone. Not closed, named: commit order — a
            // rotation committing after this UPDATE's snapshot lands the stamp and the
            // replacement waits one backoff; not worth a logical revision for a millisecond race.
            ...(target.credentialsGuard.kind === "meta" && code === "token_unavailable"
              ? [eq(mailboxCredentials.updatedAt, target.credentialsGuard.updatedAt)]
              : []),
          )))]
        : []),
    ))
    // `.returning()` rather than a row count, because the handle this pass runs on is typed as the
    // narrow transaction seam and a driver-specific `rowCount` is not on it. It is one row at most.
    .returning();
  return rows.length > 0;
}

/**
 * One scheduled pass: probe up to {@link SMTP_SIZE_BATCH} mailboxes that have never announced a
 * `SIZE`, and record what each server says. Disabled mailboxes are excluded: a disabled row
 * cannot send, so its ceiling answers no question, and dialling it would spend a login on a
 * mailbox whose credentials may since have been retired. The `attempted` set is per pass rather
 * than per process, because a serverless invocation IS the process; what stops a re-dial across
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
  // The selection has to converge, and `IS NULL` alone does not: a row stays NULL whenever the
  // answer is "nothing to record", so it re-selects those rows forever — once as many exist as
  // the batch holds, learnable rows starve behind unlearnable ones. Three fixes, only the third
  // durable: random order (a back-fill, not a queue); the batch and deadline bound one
  // invocation; the attempt stamp (mail 0063) bounds the sequence — a stamped row is not due
  // until its backoff passes. Oauth is no longer excluded: the rule now presents XOAUTH2 with the
  // token the send path mints. `COALESCE` on the code, not bare `= 'silent'`: a stamped row with
  // a NULL code would satisfy neither arm and never be due again. Timestamps go through `lte`,
  // never a `sql` template: a raw `Date` has no column to map it, postgres-js throws, PGlite
  // accepts — the failure appears only against real Postgres, where it appeared.
  const silentCutoff = new Date(started - SMTP_SIZE_RETRY_SILENT_MS);
  const failedCutoff = new Date(started - SMTP_SIZE_RETRY_FAILED_MS);
  const rows = await deps.db.select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(
      isNull(mailboxes.smtpMaxSizeBytes),
      sql`${mailboxes.status} <> 'disabled'`,
      or(
        isNull(mailboxes.smtpSizeProbedAt),
        and(sql`COALESCE(${mailboxes.smtpSizeProbeCode}, 'unknown') = 'silent'`,
          lte(mailboxes.smtpSizeProbedAt, silentCutoff)),
        and(sql`COALESCE(${mailboxes.smtpSizeProbeCode}, 'unknown') <> 'silent'`,
          lte(mailboxes.smtpSizeProbedAt, failedCutoff)),
      ),
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
