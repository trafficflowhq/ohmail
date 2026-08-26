import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { mailboxes, mailboxCredentials, type Tx } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { workerHeartbeats, accountsWithSyncDisabled } from "@trafficflow/db/cloud";
import type { KeyProvider, OAuthTokenProvider } from "@trafficflow/core";
import {
  buildImapAuth, oauthSmtpEndpoint, type ImapAuth, type CredMetaAuth,
} from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { asDatabaseFault, markDatabaseFaults } from "./db-fault.js";
import type { SyncWriteFence } from "./sync.js";

// The always-on worker reads its per-mailbox credentials from `mailbox_credentials`
// (envelope-encrypted at rest) instead of a single env mailbox. This module is
// the worker's creds boundary: it depends on @trafficflow/core + @trafficflow/db
// ONLY and decrypts with an injected KeyProvider — never on services.

type WorkerDb = ReturnType<typeof makeDb>;

/**
 * A per-transport connection profile: non-secret params (from `meta`) + the assembled `auth`.
 *
 * `auth` is the `ImapConfig` union, built by the SHARED {@link buildImapAuth} — a password row
 * yields `{ user, pass }` exactly as before, an oauth2 row yields the `fetchAccessToken` callback.
 * It is not a flat `{ user, pass }` any more precisely so this boundary cannot hand a refresh token
 * to imapflow as a password.
 */
export interface TransportCreds {
  host: string;
  port: number;
  secure: boolean;
  /**
   * `meta.insecureConsent` — the connect flow proved this server offers no TLS and the user
   * opted in to plaintext. Threaded to `ImapConfig.allowInsecure`, where it turns the mandatory
   * STARTTLS into an opportunistic one; dropped anywhere on this path, a mailbox the probe
   * admitted strands on its first sync with a STARTTLS refusal.
   */
  allowInsecure?: boolean;
  auth: ImapAuth;
}

export interface MailboxCreds {
  imap: TransportCreds;
  smtp?: TransportCreds;
}

export interface EnabledMailbox {
  accountId: string;
  mailboxId: string;
  provider: string;
  address: string;
  /** Lifecycle status as stored: 'connected' | 'error' (quarantined) | anything but 'disabled'. */
  status: string;
  /**
   * Mail migration 0027. When a human explicitly asked THIS organizer to take this mailbox over from
   * another one — the ONLY thing that lets the gate proceed past a live foreign `local`
   * claim. NULL for every mailbox nobody has authorized, which today is
   * all of them: the connect flow that stamps it lands separately.
   */
  takeoverAuthorizedAt: Date | null;
  /**
   * Mail 0027. A lease reason left over from a previous stand-down that a human has since
   * re-enabled past. Read only so the gate knows there is something to CLEAR — nothing decides
   * on it.
   */
  disabledReason: string | null;
  /**
   * Mail 0029. What the row currently says about why this mailbox is not being synced.
   *
   * READ SO THE WORKER KNOWS WHETHER THERE IS ANYTHING TO CLEAR, and for no other purpose —
   * nothing decides on it, exactly like `disabledReason` above. It is in this narrow projection
   * rather than re-read on demand because of the trap the alternative walks into: `attach` ends
   * with `if (mb.status !== "connected") await markRecovered(mb)`, and in the whole sync-blocked
   * scenario `status` IS `connected`, so `markRecovered` never runs and never clears. Without this
   * column here the worker could only either issue a clear for every healthy mailbox on every
   * roster pass, or never clear at all.
   */
  syncBlockedReason: string | null;
  /**
   * Mail 0055. The RFC 1870 `SIZE` this mailbox's submission server announced, or NULL when it has
   * never been probed. READ ONLY SO THE WORKER KNOWS WHETHER THERE IS ANYTHING TO LEARN — the
   * back-fill in `smtp-size.ts` dials once for a NULL and records what it hears, and nothing here
   * decides on the value. It is in this projection rather than re-read per mailbox because the
   * common answer is "already known", and that answer should cost no query of its own.
   */
  smtpMaxSizeBytes: number | null;
  /**
   * Mail 0039. WHEN the leader may next attach this mailbox, or NULL for "no backoff is in
   * force". THIS ONE IS DECIDED ON, unlike the two above it, and it is the only column in this
   * projection that is.
   *
   * It is what makes a quarantine survive a restart and — the point of the whole column —
   * releasable by somebody who is not this process. The in-memory `quarantine` map is still the
   * ladder; this is its durable mirror, and the roster gate prefers it whenever the durable write
   * for that mailbox actually landed. A worker that reads NULL here for a mailbox it believes it
   * quarantined has been told by an operator to try again now.
   */
  retryAfter: Date | null;
  /**
   * Mail 0023's counter, read for ONE purpose: seeding the ladder on a takeover.
   *
   * A fresh leader that finds a live `retryAfter` on a row it has never quarantined has no
   * attempt count of its own, and starting at 1 would put a mailbox that has failed forty times
   * back on the base delay. This is the durable estimate — the SIZE of the current outage — and
   * it is deliberately the better one to resume from. Nothing else decides on it.
   */
  retryCount: number;
}

/**
 * Which mailboxes THIS process is responsible for.
 *
 * There is DELIBERATELY no account filter. `TF_ACCOUNT_ID` used to narrow this selection,
 * which meant a value left in the production environment silently un-synced every OTHER
 * account — the silently-unsynced-second-account defect with extra steps, and a loud log line
 * does not remediate it. The roster is
 * now, by construction, the shard's full duty; `TF_ACCOUNT_ID` is bootstrap-only (it pairs
 * with `TF_MAILBOX_ID` to seed the legacy env mailbox's credentials, and scopes the
 * single-mailbox reconcile backstop) and cannot shrink what the worker serves.
 *
 * `shards` / `shardIndex` are the shard SEAM, shipped as `shards = 1`. With `shards > 1`
 * each process serves a DISJOINT slice of accounts, hashed on `account_id`, so the
 * per-account seq row-lock and the per-shard leader lock still serialize one account to
 * exactly one process.
 */
export interface MailboxSelection {
  shards?: number;
  shardIndex?: number;
}

function validateShard(selection: MailboxSelection): { shards: number; shardIndex: number } {
  const shards = selection.shards ?? 1;
  const shardIndex = selection.shardIndex ?? 0;
  if (!Number.isInteger(shards) || shards < 1) throw new Error(`shards must be >= 1 (got ${String(shards)})`);
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shards) {
    throw new Error(`shardIndex must be in [0, ${shards}) (got ${String(shardIndex)})`);
  }
  return { shards, shardIndex };
}

/**
 * `hashtext` is int4 and CAN be negative, so `%` alone would never match a positive
 * shardIndex for half the accounts — normalize into [0, shards). Postgres-internal
 * and stable within a major version: re-sharding is a deploy decision, not runtime.
 *
 * PERFORMANCE NOTE (for when shards > 1 actually ships): this predicate is not
 * index-supported, so a sharded deployment seq-scans `mailboxes` once per roster pass.
 * At beta scale (hundreds of rows, one pass per `TF_ROSTER_INTERVAL_MS`) that is free;
 * before shards > 1 ships, add an expression index on
 * `((hashtext(account_id::text) % n + n) % n) WHERE status <> 'disabled'` for the
 * deployed `n`, or materialize a `shard` column maintained by the mailbox writer.
 */
function shardPredicate(shards: number, shardIndex: number): SQL {
  return sql`((hashtext(${mailboxes.accountId}::text) % ${shards}) + ${shards}) % ${shards} = ${shardIndex}`;
}

/**
 * Accounts (of those given) whose BILLING STATE says their mail must not be synced — **db's
 * function, re-exported.** Read `packages/db/src/billing.ts` for why the gate is phrased as
 * "disabled" rather than "enabled" and why an account with no billing row keeps syncing.
 *
 * ── WHY THE WORKER HAS TO ASK THIS AT ALL ───────────────────────────────────────────────
 *
 * `entitlementsFor` has computed a `syncEnabled` flag since the billing gate landed and, until this gate, NOTHING
 * in production read it. The roster derived purely from `mailboxes.status <> 'disabled'`, and
 * cancellation only mirrors the Stripe status and disables mailboxes ABOVE the numeric plan
 * limit. So an account that subscribed, connected one mailbox and then cancelled kept full
 * always-on IMAP sync indefinitely — past the 30-day export window `entitlementsFor` computes
 * and the pricing page relies on. We were doing paid work, forever, for free, and telling
 * customers otherwise.
 *
 * ── AND WHY IT IS A RE-EXPORT ───────────────────────────────────────────────────────────
 *
 * This was a byte-for-byte copy of db's query, and a copy is a second answer waiting to
 * happen. It already was one: the shared question "which subscription row is this account's
 * CURRENT one" had five implementations, and the ones that took newest-of-any-status — this
 * copy included — read a dead `incomplete_expired` row in preference to a live `active` one
 * whenever an abandoned Checkout expired after the real subscription was mirrored. The
 * entitlement for `incomplete_expired` is the zero shape, so **this function parked a paying
 * account and stopped its mail**, and `alerts.ts`'s `sync_lag` rule — which reads db's copy —
 * correctly went quiet about it.
 *
 * There is now one query. The worker may import core + db only, so db is the only home both
 * this and the API side can reach; `WorkerDb` is a `PostgresJsDatabase`, which is a `PgDatabase`,
 * so db's `Tx` parameter accepts it with no wrapper and nothing to keep in step.
 */
export { accountsWithSyncDisabled };

/**
 * Every syncable mailbox in the selection: anything not soft-disabled
 * (status != 'disabled') whose account is billing-entitled to sync, oldest first so the
 * `maxMailboxes` cap truncates DETERMINISTICALLY (the same processes keep the same
 * mailboxes across restarts).
 *
 * A quarantined mailbox (status='error') IS returned — quarantine is a retry state, not a
 * terminal one; the worker's per-mailbox backoff decides when to try it again.
 *
 * The billing gate is {@link accountsWithSyncDisabled}; read its header for why a subscribed
 * account that lapses is dropped from the roster and an account with no billing row is not.
 * Dropping an account here is not destructive: `reconcileRoster` detaches its runtimes and
 * leaves the rows alone, so restoring the subscription puts it straight back on the next
 * pass with nothing to migrate.
 */
export async function loadEnabledMailboxes(
  db: WorkerDb, selection: MailboxSelection = {}, now: Date = new Date(),
): Promise<EnabledMailbox[]> {
  const { shards, shardIndex } = validateShard(selection);

  const filters: SQL[] = [ne(mailboxes.status, "disabled")];
  if (shards > 1) filters.push(shardPredicate(shards, shardIndex));

  const rows = await db
    .select({
      id: mailboxes.id, accountId: mailboxes.accountId,
      provider: mailboxes.provider, address: mailboxes.address, status: mailboxes.status,
      takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
      disabledReason: mailboxes.disabledReason,
      syncBlockedReason: mailboxes.syncBlockedReason,
      retryAfter: mailboxes.retryAfter,
      retryCount: mailboxes.retryCount,
      smtpMaxSizeBytes: mailboxes.smtpMaxSizeBytes,
    })
    .from(mailboxes)
    .where(and(...filters))
    .orderBy(asc(mailboxes.createdAt), asc(mailboxes.id));

  const parked = await accountsWithSyncDisabled(db, [...new Set(rows.map((r) => r.accountId))], now);
  return rows
    .filter((r) => !parked.has(r.accountId))
    .map((r) => ({
      accountId: r.accountId, mailboxId: r.id, provider: r.provider, address: r.address, status: r.status,
      takeoverAuthorizedAt: r.takeoverAuthorizedAt ?? null,
      disabledReason: r.disabledReason ?? null,
      syncBlockedReason: r.syncBlockedReason ?? null,
      retryAfter: r.retryAfter ?? null,
      retryCount: r.retryCount ?? 0,
      smtpMaxSizeBytes: r.smtpMaxSizeBytes ?? null,
    }));
}

/**
 * Does this account belong to the given shard? The cron backstops need it to refuse work
 * outside their own shard (a shard-1 cron must never mutate shard-0 accounts, which a
 * shard-0 worker is concurrently serving under a DIFFERENT lock key).
 */
export async function accountInShard(
  db: WorkerDb, accountId: string, selection: MailboxSelection = {},
): Promise<boolean> {
  const { shards, shardIndex } = validateShard(selection);
  if (shards === 1) return true;
  const rows = await db.execute<{ ok: boolean }>(
    sql`SELECT ((hashtext(${accountId}::text) % ${shards}) + ${shards}) % ${shards} = ${shardIndex} AS ok`,
  );
  const row = (rows as unknown as Array<{ ok: boolean }>)[0];
  return row?.ok === true;
}

/**
 * One mailbox row by id (the reconcile backstop validates its configured mailbox with it).
 *
 * It returns the SAME three fields {@link EnabledMailbox} carries for the organizer lease —
 * `status`, `takeoverAuthorizedAt`, `disabledReason` — and not merely `accountId`, because the
 * backstop has to run the same lease gate the roster path runs and the gate needs all three. The
 * roster loader gets them from `loadEnabledMailboxes`; the backstop is single-mailbox by
 * construction and gets them here, so that "which columns does the gate read" has one answer
 * rather than two. `index.ts`'s credential bootstrap reads only `accountId` and is unaffected.
 */
export async function loadMailboxById(
  db: WorkerDb, mailboxId: string,
): Promise<
  { accountId: string; status: string; takeoverAuthorizedAt: Date | null; disabledReason: string | null }
  | null
> {
  const rows = await db
    .select({
      accountId: mailboxes.accountId, status: mailboxes.status,
      takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
      disabledReason: mailboxes.disabledReason,
    })
    .from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
  return rows[0] ?? null;
}

/** The DISTINCT accounts of a mailbox set, in selection order (the per-account cron loop). */
export function accountsOf(mbs: readonly EnabledMailbox[]): string[] {
  return [...new Set(mbs.map((m) => m.accountId))];
}

/** The accounts this process is responsible for — the outer loop of every per-account pass. */
export async function loadServedAccounts(db: WorkerDb, selection: MailboxSelection = {}): Promise<string[]> {
  return accountsOf(await loadEnabledMailboxes(db, selection));
}

const PORT_DEFAULT = { imap: 993, smtp: 587 } as const;
const SECURE_DEFAULT = { imap: true, smtp: false } as const;

/** `meta` is the non-secret jsonb blob (host/port/user/secure + optional oauth fields); the secret
 *  is decrypted separately (a PASSWORD, or an oauth2 mailbox's KEK-encrypted REFRESH TOKEN). */
async function toTransport(
  row: { secretEnc: string; keyVersion: number; meta: unknown },
  transport: "imap" | "smtp",
  keyProvider: KeyProvider,
  makeFetcher?: import("@trafficflow/core/adapters/imap").AccessTokenFetcherFactory,
): Promise<TransportCreds> {
  const meta = (row.meta ?? {}) as CredMetaAuth & {
    host?: string; port?: number; secure?: boolean; insecureConsent?: boolean;
  };
  const secret = await keyProvider.decrypt(row.secretEnc, row.keyVersion);
  return {
    host: meta.host ?? "",
    port: meta.port ?? PORT_DEFAULT[transport],
    secure: meta.secure ?? SECURE_DEFAULT[transport],
    // `=== true` so a row whose marker was rewritten to `false` (a re-probe that found TLS)
    // reads exactly like a row that never had one.
    ...(transport === "imap" && meta.insecureConsent === true ? { allowInsecure: true } : {}),
    // The SHARED builder is the only reader of `meta.authType` — an oauth2 row here becomes a
    // callback, never a password, and an unhandled authType THROWS rather than leaking the secret.
    auth: buildImapAuth(meta, secret, makeFetcher),
  };
}

/**
 * Load + decrypt a mailbox's credentials. Reads its `mailbox_credentials` rows,
 * decrypts each `secret_enc` via the KeyProvider (KEK version per-row, so rotation
 * works), and merges with the non-secret `meta`. Returns null when there is no
 * 'imap' row — nothing for the worker to connect to yet (e.g. an oauth-only or
 * not-yet-provisioned mailbox), which the caller SKIPS rather than errors.
 */
export async function loadMailboxCreds(
  db: WorkerDb, mailboxId: string, keyProvider: KeyProvider,
  tokenProvider?: OAuthTokenProvider,
): Promise<MailboxCreds | null> {
  const rows = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mailboxId));
  const byTransport = new Map(rows.map((r) => [r.transport, r]));

  const imapRow = byTransport.get("imap");
  if (!imapRow) return null;
  // The token source, bound to THIS mailbox, so a rotated refresh token persists to its own row and
  // the per-mailbox access-token cache keys correctly. Absent ⇒ oauth rows refuse (see buildImapAuth).
  const makeFetcher = tokenProvider?.forMailbox(mailboxId);
  const imap = await toTransport(imapRow, "imap", keyProvider, makeFetcher);

  const smtpRow = byTransport.get("smtp");
  // ── AN OAUTH MAILBOX HAS NO `smtp` ROW, AND IT STILL HAS A SUBMISSION ENDPOINT ─────────────
  //
  // One refresh token covers both transports, so the connect flow stores no second row and the
  // submission host/port/secure live in the imap row's `meta.smtp`. Returning `undefined` for
  // `smtp` here — which is what this did — told every caller "this mailbox cannot submit", and the
  // one caller that believed it was the `SIZE` back-fill: an oauth mailbox was reported as having
  // no SMTP credentials and therefore never learned what its server accepts, on ANY host.
  //
  // The `auth` handed back is `imap.auth` ITSELF, not a second assembly of it: the same token
  // callback, so the same per-mailbox access-token cache and the same rotated-refresh-token write.
  // This is `makeSendAdapter`'s resolution on the API host, and the coordinates come from the
  // shared `oauthSmtpEndpoint` so the two cannot drift about a default port.
  const smtp = smtpRow
    ? await toTransport(smtpRow, "smtp", keyProvider, makeFetcher)
    : oauthSmtpFor(imapRow.meta, imap);

  return smtp ? { imap, smtp } : { imap };
}

/**
 * The submission profile of an OAUTH mailbox, or `undefined` for anything else.
 *
 * Keyed on `meta.authType` rather than on the shape of `imap.auth`, because the question being asked
 * is "does this mailbox's stored credential describe an oauth submission endpoint" — a property of
 * the row — and `buildImapAuth` has already refused anything oauth-shaped it cannot serve by the
 * time this runs.
 */
function oauthSmtpFor(meta: unknown, imap: TransportCreds): TransportCreds | undefined {
  const m = (meta ?? {}) as CredMetaAuth & { smtp?: { host?: string; port?: number; secure?: boolean } };
  if (m.authType !== "oauth2") return undefined;
  return { ...oauthSmtpEndpoint(m.smtp), auth: imap.auth };
}

export interface BootstrapInput {
  mailboxId: string;
  imap: { host: string; port: number; secure: boolean; user: string; pass: string };
  smtp?: { host: string; port: number; secure: boolean; user?: string; pass?: string };
}

/**
 * ONE-SHOT idempotent env→DB creds bootstrap (RC3). Keeps the legacy single env
 * mailbox syncing across the 0007 cutover with no manual step: if NO
 * `(mailboxId,'imap')` row exists yet, encrypt the env creds and INSERT the imap
 * (+ smtp when present) rows. If an imap row already exists, DO NOTHING — env
 * NEVER overwrites DB creds. The gate is the imap row alone (the single leader
 * lock guarantees no concurrent bootstrap, so a check-then-insert is safe).
 */
export async function bootstrapEnvCreds(
  db: WorkerDb, keyProvider: KeyProvider, input: BootstrapInput,
): Promise<void> {
  const existing = await db
    .select({ transport: mailboxCredentials.transport })
    .from(mailboxCredentials)
    .where(and(eq(mailboxCredentials.mailboxId, input.mailboxId), eq(mailboxCredentials.transport, "imap")))
    .limit(1);
  if (existing.length > 0) return; // RC3: a DB row wins — never overwrite it with env

  const now = new Date();
  const imapEnc = await keyProvider.encrypt(input.imap.pass);
  await db.insert(mailboxCredentials).values({
    mailboxId: input.mailboxId, transport: "imap",
    secretEnc: imapEnc.ciphertext, keyVersion: imapEnc.keyVersion,
    meta: { host: input.imap.host, port: input.imap.port, secure: input.imap.secure, user: input.imap.user },
    updatedAt: now,
  });

  if (input.smtp) {
    // A generic IMAP mailbox usually shares its password/user with SMTP.
    const smtpPass = input.smtp.pass ?? input.imap.pass;
    const smtpEnc = await keyProvider.encrypt(smtpPass);
    await db.insert(mailboxCredentials).values({
      mailboxId: input.mailboxId, transport: "smtp",
      secretEnc: smtpEnc.ciphertext, keyVersion: smtpEnc.keyVersion,
      meta: { host: input.smtp.host, port: input.smtp.port, secure: input.smtp.secure, user: input.smtp.user ?? input.imap.user },
      updatedAt: now,
    });
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   WHY A MAILBOX FAILED (mail migration 0023)
   ══════════════════════════════════════════════════════════════════════════════════════════

   `status` used to be the ENTIRE record of a failure. In one disk-full incident the fault
   quarantined a real production mailbox and the only thing anyone could read afterwards was
   `status='error'` — the diagnostic lived in the worker's memory and in a log line, and the
   process had since restarted. Settings → Mailboxes said "Sync failed" and the admin console's
   `lastError` was a hardcoded `null` with a comment apologising for it.

   These two functions are now the ONLY way the worker writes `mailboxes.status`. The former
   `setMailboxStatus(db, id, status)` is deliberately gone rather than kept beside them: a
   generic status setter is a call site that can flip a mailbox to `error` and forget the
   reason, and the whole point of this slice is that such a call site should not exist.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The failure taxonomy is defined ONCE, in `@trafficflow/db` beside the column it constrains
 * — it used to be written out here, again in `services/dto/types.ts`, and again in a
 * comment on the column, with nothing keeping the three in step. Re-exported so this module's
 * existing importers do not have to care where it moved.
 */
import type { MailboxErrorCode } from "@trafficflow/db";
export type { MailboxErrorCode };

/** Where the throw came from. It decides only the FALLBACK, never a positive classification. */
export type MailboxErrorPhase = "attach" | "sync";

const CONNECT_ERRNOS: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH", "ENETDOWN",
  "ECONNRESET", "EPIPE", "EAI_AGAIN", "EADDRNOTAVAIL",
]);

/* ── THE MAIL SERVER IS NOT AVAILABLE, WHICH IS NOT A REJECTED PASSWORD ─────────────────────

   Two sets, one per channel, because a provider that will not serve us says so in two different
   places and the worker recognised neither.

   A provider at its per-account connection cap answers `* BYE [UNAVAILABLE] Maximum number of
   connections…` and closes. `serverBye` (`imapflow@1.5.0`, `imap-flow.js:1553-1566`) keeps only
   the TEXT attributes of that reply as `byeReason` — a bracket atom is a SECTION, not TEXT — so
   THE BRACKET ATOM NEVER BECOMES `serverResponseCode` on this shape. The pending LOGIN is
   rejected by `createNoConnectionError` (`:1987-1994`) carrying `code` and nothing else, and
   `commands/login.js:38` then stamps `authenticationFailed = true` onto whatever it caught.

   That is why the fix is BOTH sets rather than the response code alone: reordering the response-
   code probe fixes the tagged `A1 NO [LIMIT] …` variant and leaves the commoner one untouched.

   NEITHER SET WIDENS WHAT CAN BE STORED. Every member below is already in {@link IMAPFLOW_CODES}
   or {@link IMAP_RESPONSE_CODES}, so all of them were already legal `error_detail` values while
   being unclassifiable — the failure had a name in the row and no name in the taxonomy. They are
   spread into {@link MAILBOX_ERROR_DETAIL_TOKENS} anyway, so that Set's stated coupling ("nothing
   becomes storable without appearing in one of these lists") keeps being literally true. */

/**
 * The INSTALLED client's own words for a server that did not serve us. Not errnos — hence a set
 * of their own rather than four more members of {@link CONNECT_ERRNOS}.
 *
 * `NoConnection` (`imap-flow.js:1987-1994`, and `:486`/`:628`/`:3756`), `EConnectionClosed`
 * (`:636`/`:3097`) and the two `ClosedAfterConnect*` (`:2032`, a close landing while the connect
 * promise is still pending — that one never reaches the LOGIN catch, so it carries no flag and
 * used to fall all the way to the phase fallback and report `unknown`).
 *
 * `ETHROTTLE` (`:862`) is the fifth for a reason worth stating: it is set when a server answers
 * a tagged failure with *"Request is throttled. Suggested Backoff Time: N"* — Office 365's rate
 * limit — and that handler is the GENERIC tagged-response path, so it fires for LOGIN like any
 * other command and `login.js` stamps the flag on it too. Leaving it out would knowingly ship the
 * identical sentence about the identical mechanism, one provider over.
 *
 * The throttle carries `err.throttleReset`, the server's own suggested backoff, and this worker's
 * retry ladder ignores it. That is a real gap and it is not this one: the ladder lives in the
 * worker's main loop, not here.
 */
const SERVER_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "NoConnection", "EConnectionClosed", "ClosedAfterConnectText", "ClosedAfterConnectTLS",
  "ETHROTTLE",
]);

/**
 * RFC 5530 response codes that mean THE SERVER WILL NOT SERVE US RIGHT NOW.
 *
 * `UNAVAILABLE` is "a subsystem is temporarily down"; `LIMIT` is "an implementation limit was
 * reached", which is what a per-account connection cap is. A server that answers either has
 * received and parsed our LOGIN, so neither is a statement about credentials.
 *
 * CLOSED AND NAMED, never "an atom that looks like a refusal". The forged-token rule applies to reading a
 * server-chosen token as much as to storing one: an atom this set does not contain must fall
 * THROUGH to the evidence below it, so a hostile endpoint answering `NO [SECRETPASSWORD123]`
 * cannot suppress the auth verdict by handing us a word we do not know.
 */
const SERVER_UNAVAILABLE_RESPONSE_CODES: ReadonlySet<string> = new Set(["UNAVAILABLE", "LIMIT"]);

/**
 * OAuth token-refresh codes that are safe to STORE in `error_detail`.
 *
 * Only `OAUTH_INVALID_GRANT` — the re-auth verdict a user acts on ("reconnect this mailbox"). It is
 * a constant this codebase chose, not a server-supplied atom, so echoing it back to the account
 * owner tells them what happened without letting anyone else pick the words (the whole point of the
 * closed allowlist below). The provider-unavailable and config-missing codes are deliberately NOT
 * here: their `error_code` (`connect`/`unknown`) is what a human acts on, and a null detail is a
 * fine answer.
 */
const OAUTH_ERROR_DETAIL_CODES: ReadonlySet<string> = new Set(["OAUTH_INVALID_GRANT"]);

/**
 * Timeouts — Node's errnos AND the ones the INSTALLED IMAP client actually emits.
 *
 * The four imapflow codes were missing, and their absence was not theoretical: `imapflow@1.5.0`
 * sets `err.code = 'CONNECT_TIMEOUT'` (imap-flow.js:1853), `'GREETING_TIMEOUT'` (:1879),
 * `'UPGRADE_TIMEOUT'` (:1330) and `'ETIMEOUT'` (:967) — which are, between them, EVERY way a
 * provider that accepts the TCP connection and then stops answering is reported. All four were
 * classified `unknown` (or `sync`), so the single most common shape of a flaky provider was
 * indistinguishable from "we have no idea", and the UI could not say "the server did not
 * answer in time" about the failure it says it most.
 */
const TIMEOUT_ERRNOS: ReadonlySet<string> = new Set([
  "ETIMEDOUT", "ESOCKETTIMEDOUT", "ERR_SOCKET_CONNECTION_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "57014",   // 57014 = query_canceled, i.e. our own statement_timeout
  // imapflow@1.5.0's own timeout constants — see the note above.
  "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT", "ETIMEOUT",
]);

/**
 * SQLSTATEs that mean OUR storage failed, not the customer's mailbox.
 *
 * This is the class that produced the outage this slice comes from: Postgres answered
 * `53100 disk_full`, every ingest threw, and each mailbox in turn hit `maxSyncFailures` and was
 * quarantined — so the database being full was rendered to the user as "your mailbox is
 * broken". A distinct code is what lets the UI say the true thing instead.
 */
const STORAGE_SQLSTATES: ReadonlySet<string> = new Set([
  "53100",  // disk_full
  "53200",  // out_of_memory
  "54000",  // program_limit_exceeded (a row that cannot be stored at all)
  "22001",  // string_data_right_truncation
  "23514",  // check_violation — `message_bodies_html_cap` is the one that fires here
]);

/** The OpenSSL / Node verification constants imapflow surfaces verbatim. */
const CERT_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "EPROTO",
]);

function isTlsCode(code: string): boolean {
  return code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || CERT_CODES.has(code);
}

/** The shapes a thrown value can carry that we are willing to READ. */
interface ErrorShape {
  code?: unknown;
  name?: unknown;
  message?: unknown;
  authenticationFailed?: unknown;
  serverResponseCode?: unknown;
}

const codeOf = (err: unknown): string =>
  typeof (err as ErrorShape | null)?.code === "string" ? String((err as ErrorShape).code) : "";

const responseCodeOf = (err: unknown): string =>
  typeof (err as ErrorShape | null)?.serverResponseCode === "string"
    ? String((err as ErrorShape).serverResponseCode) : "";

/**
 * Classify a throw into {@link MailboxErrorCode}.
 *
 * ── IT MAY READ THE MESSAGE. IT MAY NOT STORE IT. ───────────────────────────────────────
 *
 * Everything structural is preferred — `err.code`, imapflow's `authenticationFailed` and
 * `serverResponseCode` — and one narrow message probe remains for authentication, because a
 * rejected password is the single most common real failure and several IMAP servers report it
 * with no structured marker at all. That probe is safe precisely because its OUTPUT is a
 * seven-value enum: the message informs the classification and never leaves this function.
 * {@link mailboxErrorDetail} is where the storage rule lives.
 *
 * ── WHERE THE `authenticationFailed` FLAG SITS IS THE WHOLE OF THE RECLASSIFICATION ──────
 *
 * It used to be read FIRST, and it is the weakest evidence in this function. `imapflow@1.5.0`
 * sets it in the `catch` around the LOGIN command, unconditionally and after it has already
 * assigned `serverResponseCode` (`lib/commands/login.js:33-41`; identically in
 * `lib/commands/authenticate.js:12-23` for the SASL/OAuth path). It therefore means "the LOGIN
 * command did not succeed" — NOT "the server rejected these credentials" — and that same `catch`
 * swallows a socket the server hung up on, a connection the client had already closed, a server
 * at its per-account connection cap, and a provider throttling us.
 *
 * Reading it first made every structural probe below it unreachable for LOGIN errors, and a login
 * error is what `attach()` sees. A provider having a busy minute was rendered to the mailbox's
 * owner as *"the mailbox rejected the password"* — and the worker's main loop quarantines an
 * attach failure on its FIRST occurrence, so it took one refused dial, not three.
 *
 * So the two NAMED refusal sets and the errno probe now sit above the flag, and the flag keeps
 * exactly the job it can do honestly: a server answering a bare `A1 NO Login failed.` with no
 * bracket atom and no errno leaves it as the only evidence there is, and `auth` is then right.
 *
 * ── WHAT DID *NOT* MOVE, AND WHY THAT IS NOT TIDINESS DEFERRED ──────────────────────────
 *
 * The `AUTHENTICATIONFAILED` / `AUTHORIZATIONFAILED` / `OVERQUOTA` probe stays BELOW the flag,
 * deliberately, so that this slice reclassifies only what it names.
 *
 * The two auth atoms are inert either way — they answer `auth` and so does the flag. `OVERQUOTA`
 * is not: promoting it would move a LOGIN answered `NO [OVERQUOTA]` from `auth` to `storage`, and
 * the copy for `storage` says ohmail could not store the mail and *"this one is on us"*. That
 * would have this worker apologise for a full mailbox on somebody else's server — a false claim
 * shipped by the deploy that fixes a false claim. Left alone, that case keeps whatever answer it
 * had, and `OVERQUOTA` from a non-login command keeps reaching `storage` exactly as before.
 *
 * The errno probe DID move above the flag as a block. Three of its four arms are the same defect
 * as the one this slice is about — a LOGIN that timed out, or died on TLS, is not a rejected
 * password either — and the fourth, {@link STORAGE_SQLSTATES}, is inert here for a structural
 * reason: a SQLSTATE arrives on a database driver's error and `authenticationFailed` is stamped
 * by an IMAP client, so no value can carry both.
 *
 * ── AND THE ASYMMETRY WITH `mailboxErrorDetail`, WHICH IS ALSO DELIBERATE ────────────────
 *
 * Reading a server-chosen token to CLASSIFY is safe because the output is a closed enum; STORING
 * one is not, which is why {@link MAILBOX_ERROR_DETAIL_TOKENS} exists. Both refusal sets above
 * are closed and named for the same reason in the other direction: an atom or code they do not
 * contain falls THROUGH rather than being swallowed, so no server can talk this function out of
 * an `auth` verdict by handing it a word nobody knows.
 */
export function classifyMailboxError(err: unknown, phase: MailboxErrorPhase): MailboxErrorCode {
  const e = err as ErrorShape | null;

  // ── ABOVE THE FLAG: what the server or the socket NAMED. See the block above. ──────────
  const server = responseCodeOf(err);
  if (SERVER_UNAVAILABLE_RESPONSE_CODES.has(server)) return "connect";

  const code = codeOf(err);
  if (code) {
    // ── OAuth token-refresh verdicts, keyed on the code the token client stamped. ──────────
    // `invalid_grant` is the ONE auth outcome: the stored refresh token is dead, the user must
    // reconnect. A token-endpoint outage carries `OAUTH_TOKEN_ENDPOINT_UNAVAILABLE` and is
    // `connect` — "retry later" — NEVER auth, so a Microsoft blip cannot quarantine every oauth
    // mailbox as bad credentials. `OAUTH_CONFIG_MISSING` (a deployment with no client secret) is a
    // named refusal that is our fault, not the mailbox's, so it is `unknown`, not `auth`.
    if (code === "OAUTH_INVALID_GRANT") return "auth";
    if (code === "OAUTH_TOKEN_ENDPOINT_UNAVAILABLE") return "connect";
    if (isTlsCode(code)) return "tls";
    if (TIMEOUT_ERRNOS.has(code)) return "timeout";
    if (CONNECT_ERRNOS.has(code) || SERVER_UNAVAILABLE_CODES.has(code)) return "connect";
    if (STORAGE_SQLSTATES.has(code)) return "storage";
  }

  // ── THE FLAG: "the LOGIN command did not succeed", and nothing above it explained why. ──
  if (e?.authenticationFailed === true) return "auth";

  // ── BELOW THE FLAG, UNCHANGED: reachable only when no flag was set, i.e. from a command
  //    other than LOGIN. Read the block above before moving either line. ──────────────────
  if (server === "AUTHENTICATIONFAILED" || server === "AUTHORIZATIONFAILED") return "auth";
  if (server === "OVERQUOTA") return "storage";

  const message = typeof e?.message === "string" ? e.message : "";
  if (/\b(authentication|login|credentials|password)\b.*\b(fail|refus|reject|invalid|denied)/i.test(message)
    || /\b(invalid|incorrect)\b.*\b(credentials|password|login)\b/i.test(message)) {
    return "auth";
  }

  // A throw out of the sync cycle that we cannot name is still a SYNC failure, and saying so
  // is more useful than "unknown": it tells the reader the mailbox connected and authenticated
  // and then something went wrong while reading it.
  return phase === "sync" ? "sync" : "unknown";
}

/** Bound on `mailboxes.error_detail`. Every allowlist member below is far shorter. */
export const MAILBOX_ERROR_DETAIL_MAX = 200;

/* ── THE CLOSED ALLOWLIST ─────────────────────────────────────────────────────────────────

   This replaced a SHAPE test (`/^[A-Z][A-Z0-9_-]{0,63}$|^[0-9A-Z]{5}$/`), and the difference
   is the whole finding. A shape test asks "does this look like a response code"; it never asks
   WHO CHOSE IT. imapflow derives `err.serverResponseCode` by uppercasing the first bracket atom
   of the server's own reply (`tools.js:272-281`, `getStatusCode`), so a hostile endpoint that
   accepts LOGIN and answers

       * NO [SECRETPASSWORD123] authentication failed

   hands us `serverResponseCode = "SECRETPASSWORD123"`. It passed the regex, and it landed in a
   column the account owner reads in Settings → Mailboxes AND the admin console reads as
   `lastError` — an account-isolation breach chosen entirely by an attacker who controls a mail server the
   user was tricked into adding, or by any provider having a bad day with a verbose NO.

   Membership is the fix, because membership cannot be forged: a token is storable only if it is
   a name WE already knew. Anything else is NULL, and NULL is a perfectly good answer —
   `error_code` carries the part a human acts on. */

/**
 * IMAP response codes: RFC 3501 §7.1, RFC 5530 (the enhanced set), and the extension codes a
 * CONDSTORE/QRESYNC/quota-aware client can actually be handed.
 *
 * Nothing here is free-text. Each is a protocol constant, so echoing one back to the mailbox
 * owner tells them what the server said WITHOUT letting the server choose the words.
 */
const IMAP_RESPONSE_CODES: readonly string[] = [
  // RFC 3501 §7.1
  "ALERT", "BADCHARSET", "CAPABILITY", "PARSE", "PERMANENTFLAGS", "READ-ONLY", "READ-WRITE",
  "TRYCREATE", "UIDNEXT", "UIDVALIDITY", "UNSEEN",
  // RFC 5530 — the ones that make a failure legible
  "UNAVAILABLE", "AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED", "EXPIRED", "PRIVACYREQUIRED",
  "CONTACTADMIN", "NOPERM", "INUSE", "EXPUNGEISSUED", "CORRUPTION", "SERVERBUG", "CLIENTBUG",
  "CANNOT", "LIMIT", "OVERQUOTA", "ALREADYEXISTS", "NONEXISTENT",
  // Extensions this client speaks or can be answered with
  "UIDNOTSTICKY", "APPENDUID", "COPYUID",                    // RFC 4315
  "CLOSED", "MODIFIED", "NOMODSEQ", "HIGHESTMODSEQ",         // RFC 7162 (CONDSTORE/QRESYNC)
  "COMPRESSIONACTIVE",                                       // RFC 4978
  "USEATTR", "HASCHILDREN",                                  // RFC 6154 / RFC 5258
  "METADATA", "TOOMANY", "LONGENTRIES", "MAXSIZE", "NOPRIVATE", // RFC 5464
  "UNKNOWN-CTE", "TOOBIG", "REFERRAL", "NOTSAVED",           // RFC 3516 / 4469 / 2193 / 5182
  "NOTIFICATIONOVERFLOW", "BADEVENT",                        // RFC 5465
  "MAILBOXID",                                               // RFC 8474
  "WEBALERT",                                                // Gmail; the atom only, never its URL
];

/**
 * imapflow@1.5.0's OWN `err.code` constants, read out of the installed package rather than
 * remembered. Grepped from `lib/imap-flow.js`; the timeout four also live in
 * {@link TIMEOUT_ERRNOS} because they carry a classification as well as a detail.
 */
const IMAPFLOW_CODES: readonly string[] = [
  "NoConnection", "StateLogout", "EConnectionClosed", "ClosedAfterConnectTLS",
  "ClosedAfterConnectText", "InvalidResponse", "ETHROTTLE", "LockTimeout", "ProxyError",
  "STARTTLS_INJECTION",
];

/**
 * TLS/OpenSSL constants, ENUMERATED rather than prefix-matched.
 *
 * {@link isTlsCode} still uses `startsWith("ERR_TLS_")` for CLASSIFICATION, and that is fine —
 * its output is a seven-value enum. Storage may not use a prefix rule: a prefix is a shape, and
 * a shape is what the forged-token finding walked through. An OpenSSL constant we did not list stores NULL and still
 * reports `error_code: "tls"`.
 */
const TLS_DETAIL_CODES: readonly string[] = [
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_HANDSHAKE_TIMEOUT", "ERR_TLS_INVALID_PROTOCOL_VERSION",
  "ERR_TLS_PROTOCOL_VERSION_CONFLICT", "ERR_TLS_REQUIRED_SERVER_NAME", "ERR_TLS_SNI_FROM_IP",
  "ERR_TLS_DH_PARAM_SIZE", "ERR_TLS_RENEGOTIATION_DISABLED", "ERR_TLS_INVALID_CONTEXT",
  "ERR_TLS_INVALID_STATE", "ERR_TLS_SESSION_ATTACK",
  "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_UNEXPECTED_MESSAGE", "ERR_SSL_NO_PROTOCOLS_AVAILABLE",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG", "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
  "ERR_SSL_CERTIFICATE_VERIFY_FAILED", "ERR_SSL_UNSUPPORTED_PROTOCOL", "ERR_SSL_BAD_LENGTH",
];

/** Node errnos that are not connect/timeout but still name a real, non-secret condition. */
const NODE_ERRNOS: readonly string[] = [
  "EACCES", "EPERM", "EADDRINUSE", "ECONNABORTED", "EMFILE", "ENFILE", "ENOMEM", "ENOSPC",
  "EIO", "ERR_STREAM_PREMATURE_CLOSE", "ERR_SOCKET_CLOSED", "ABORT_ERR",
];

/**
 * SQLSTATEs. OUR storage's vocabulary, not the customer's mailbox — and the reason the old
 * `^[0-9A-Z]{5}$` alternative existed at all. Enumerated for the same reason as the TLS set:
 * five uppercase characters is a shape, and `53100` is a fact.
 */
const SQLSTATE_DETAILS: readonly string[] = [
  "53100", "53200", "54000", "22001", "23514",   // the storage set, verbatim
  "23503", "23505", "22P02", "42P01", "42703",   // FK / unique / bad text / missing relation or column
  "40001", "40P01", "57014", "57P01", "57P03",   // serialization, deadlock, cancel, admin shutdown, starting up
  "08000", "08003", "08006", "08P01", "53300",   // connection family + too_many_connections
];

/**
 * THE ONLY VALUES `mailboxes.error_detail` MAY HOLD. Closed, by membership.
 *
 * Frozen at module load from the sets the classifier already keeps, so the taxonomy and the
 * storage rule cannot drift apart: adding an errno to {@link CONNECT_ERRNOS} makes it storable
 * in the same commit, and nothing becomes storable without appearing in one of these lists.
 */
export const MAILBOX_ERROR_DETAIL_TOKENS: ReadonlySet<string> = new Set<string>([
  ...IMAP_RESPONSE_CODES,
  ...IMAPFLOW_CODES,
  ...TLS_DETAIL_CODES,
  ...NODE_ERRNOS,
  ...SQLSTATE_DETAILS,
  ...CONNECT_ERRNOS,
  ...TIMEOUT_ERRNOS,
  ...STORAGE_SQLSTATES,
  ...CERT_CODES,
  // The reclassification's two sets. Every member is ALREADY reachable through the two lists above them
  // — that is the finding, not an oversight: the tokens were storable while being unclassifiable
  // — so these two spreads widen nothing. They are here so the sentence above stays literally
  // true rather than true by coincidence, and so the next classifier set is added the same way.
  ...SERVER_UNAVAILABLE_CODES,
  ...SERVER_UNAVAILABLE_RESPONSE_CODES,
  // OAuth's one storable detail. Added WITH the classifier arm that emits it (see
  // classifyMailboxError's OAUTH_INVALID_GRANT → 'auth'), so the taxonomy and the storage rule stay
  // in step — the same discipline every set above this line follows.
  ...OAUTH_ERROR_DETAIL_CODES,
]);

/**
 * Is this a value `mailboxes.error_detail` is allowed to hold?
 *
 * Exported because it is the guard at BOTH ends of the pipe: {@link mailboxErrorDetail} builds
 * with it, and {@link markMailboxFailed} re-checks with it at the write site — so "the single
 * safe write site" is enforced rather than merely conventional. A caller that hands
 * `{ detail: err.message }` typechecks (the parameter is a `string | null`) and stores NULL.
 */
export function isSafeMailboxErrorDetail(value: unknown): value is string {
  return typeof value === "string" && MAILBOX_ERROR_DETAIL_TOKENS.has(value);
}

/**
 * The ONLY value that may be written to `mailboxes.error_detail`.
 *
 * ── NEVER `err.message`, `err.stack`, OR SERVER FREE-TEXT ────────────────────────────────
 *
 * This column is read by the account's own user AND by the admin console, so what goes in it
 * is an account-isolation question before it is a usability one. A throw out of `runSyncCycle` can be a
 * parse or constraint error that embeds RFC822 header bytes — a sender, a subject — and a
 * failed login's server text can echo the login argument. `packages/core/src/log.ts` already
 * settled the same question for every log line ("`err` is serialised to CLASS + CODE, never
 * message + stack"); this inherits that contract rather than inventing a weaker one.
 *
 * The detail is a MEMBERSHIP test against {@link MAILBOX_ERROR_DETAIL_TOKENS}, never a shape
 * test — read the block above that Set for the attacker-chosen token a shape test admits.
 */
export function mailboxErrorDetail(err: unknown): string | null {
  for (const candidate of [responseCodeOf(err), codeOf(err)]) {
    if (isSafeMailboxErrorDetail(candidate)) return candidate.slice(0, MAILBOX_ERROR_DETAIL_MAX);
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   FENCING THE TWO LIFECYCLE WRITES
   ══════════════════════════════════════════════════════════════════════════════════════════

   Both writes used to be `WHERE id = ?` and nothing else — last-writer-wins across two
   boundaries the worker does not control:

   · **A LEADER HANDOFF.** Worker A loses its session advisory lock with an attach or a sync
     still in flight; worker B acquires the shard and starts serving the same mailbox. A's write
     lands afterwards, and completion ORDER decides the persisted truth. B can record a verified
     recovery while A then records the failure it saw four minutes ago, or the reverse: a healthy
     mailbox quarantined, or a dead one reported connected.

   · **THE USER'S OWN DISCONNECT.** A quarantined mailbox begins a long recovery from an `error`
     snapshot; the user disconnects it (`status='disabled'`, credentials deleted); the recovery
     lands, writes `connected`, and the mailbox is back on the roster — `loadEnabledMailboxes`
     selects everything that is not `disabled`. The user's most consequential action on this
     screen, silently undone by a write that started before it.

   Both are closed with a predicate IN the statement rather than a check before it:

   · `status <> 'disabled'` — the worker never has authority to un-disable. Only the account's
     own PATCH re-enables a mailbox.
   · an EXISTS against `worker_heartbeats` for (shard, instance, leader) — the leader epoch,
     already durable and already claimed atomically by `writeHeartbeat` on takeover. This is the
     same guard `refreshHeartbeat` uses to refuse a surrendered leader's late pulse; reusing it
     means there is one definition of "am I still the leader of this shard", not two.

   `.returning()` rather than a driver-specific row count, so "was I fenced out?" is answerable
   through PGlite and postgres-js alike, and the caller can log it. */

/** Who is claiming to write: this shard, and this process. Absent ⇒ unfenced (tests, backstops). */
export interface LeaderFence {
  shardIndex: number;
  instanceId: string;
}

/** `worker_heartbeats` still names THIS instance as the live leader of THIS shard. */
function leaderStillOurs(fence: LeaderFence): SQL {
  return sql`exists (
    select 1 from ${workerHeartbeats}
    where ${workerHeartbeats.shardIndex} = ${fence.shardIndex}
      and ${workerHeartbeats.instanceId} = ${fence.instanceId}
      and ${workerHeartbeats.leader} = true
  )`;
}

function lifecycleWhere(mailboxId: string, fence?: LeaderFence): SQL {
  const parts: SQL[] = [
    sql`${mailboxes.id} = ${mailboxId}`,
    // The user's disconnect outranks every worker write, whenever it happened.
    sql`${mailboxes.status} <> 'disabled'`,
  ];
  if (fence) parts.push(leaderStillOurs(fence));
  return sql.join(parts, sql` and `);
}

/**
 * RUN A FENCED LIFECYCLE WRITE — the row is CLAIMED first, and only then is the fence asked.
 *
 * ── WHY THE PREDICATE ALONE WAS NOT ENOUGH ────────────────────────────────────────────────
 *
 * `leaderStillOurs` is an UNCORRELATED `EXISTS` over another table, and READ COMMITTED has an
 * explicit rule about what such a subquery sees when the statement carrying it has to WAIT: an
 * updating command *"can see the effects of concurrent updating commands on the same rows it is
 * trying to update, but it does not see effects of those commands on other rows in the
 * database."* `worker_heartbeats` is another row. So a single fenced `UPDATE` that blocks on the
 * mailbox row is answered — whether the planner hoists the subquery to an `InitPlan` or leaves
 * it as a qual for EvalPlanQual to re-evaluate — with the LEADERSHIP THE STATEMENT BEGAN WITH.
 *
 * That window is not exotic; it is the shape of every handoff. Worker A issues its write, blocks
 * behind somebody else's lock on that mailbox row, worker B takes the shard over and commits, the
 * lock goes, and A's write lands anyway. The fence FAILS OPEN in exactly the case it exists for.
 * Measured against real Postgres by a suite that drives the interleave with a parked lock —
 * and had A quarantine a mailbox it no longer led.
 *
 * ── THE FIX IS TO MOVE THE WAIT OFF THE FENCED STATEMENT ──────────────────────────────────
 *
 * One transaction, two statements. The first is a bare `SELECT … FOR UPDATE` that asserts nothing
 * — its whole job is to absorb the lock wait and come back holding the row. The second is the
 * fenced `UPDATE`, and in READ COMMITTED it takes a FRESH snapshot at its own start: after the
 * wait, so it sees a takeover that committed during it. It cannot block, because we already hold
 * the only row it names, so there is no second wait for a stale snapshot to hide behind.
 *
 * A takeover that commits after that second snapshot is a different thing and is not a defect:
 * the leader was the leader at the moment it decided. That race is inherent to a lease and is the
 * one the heartbeat's own staleness window covers.
 *
 * UNFENCED CALLERS ARE UNCHANGED — one statement, no transaction. Tests and backstops pass no
 * fence, and there is nothing for them to be raced out of.
 */
async function applyFenced(
  db: WorkerDb, mailboxId: string, fence: LeaderFence | undefined,
  write: (db: WorkerDb) => Promise<Array<{ id: string }>>,
): Promise<boolean> {
  if (!fence) return (await write(db)).length > 0;
  return db.transaction(async (tx) => {
    // The claim. `.for("update")` is the point of the statement; the columns are irrelevant.
    // A row that has vanished is refused here rather than by the write that follows.
    const held = await tx.select({ id: mailboxes.id }).from(mailboxes)
      .where(eq(mailboxes.id, mailboxId)).for("update");
    if (held.length === 0) return false;
    // The same cast the services layer uses between a `Db` and a `Tx`: the transaction exposes
    // the query surface these writers use, and typing every one of them against both would say
    // nothing the callers do not already state.
    return (await write(tx as unknown as WorkerDb)).length > 0;
  });
}

/**
 * THE SAME FENCE, OVER THE MAIL-BEARING WRITES — `SyncDeps.fence` for one mailbox.
 *
 * `applyFenced` above covers the two mailbox LIFECYCLE writes; this covers everything
 * `runSyncCycle` persists — `messages` (and its instances), `mailbox_folders` cursors,
 * `change_log`, `folder_state`/`flag_state`, `message_failures`, `audit_log` — with the SAME
 * definition of leadership (`worker_heartbeats` naming this shard + instance with
 * `leader = true`) and the SAME two-statement shape, for the same EvalPlanQual reason spelled
 * out in the block above `applyFenced`:
 *
 *   1. a bare `SELECT … FOR UPDATE` on the MAILBOX row absorbs any lock wait and asserts
 *      nothing. The mailbox row is the anchor every fenced writer of this mailbox claims
 *      first, so two workers contending for one mailbox meet HERE — at a statement that is
 *      allowed to wait — and never at a fenced statement whose subquery would be answered
 *      from the snapshot it began with;
 *   2. the leadership check is its OWN statement after the claim. Under READ COMMITTED it
 *      takes a fresh snapshot at its own start — after the wait — so a takeover that
 *      committed while this transaction was parked is seen, and the whole group is refused
 *      with nothing written. A `SELECT` cannot block, so there is no second wait for a stale
 *      snapshot to hide behind.
 *
 * A takeover that commits AFTER that check, while the group's writes run, is the lease's
 * inherent race (the leader was the leader at the moment it decided) — the same residual
 * `applyFenced` documents and accepts.
 *
 * The row's DISABLED status is deliberately NOT part of this fence, unlike `lifecycleWhere`:
 * a refusal here is read by the worker as proof of lost shard leadership and quiesces the
 * whole instance, which is the right response to a heartbeat naming somebody else and the
 * wrong response to one mailbox being switched off. Disablement is enforced where it always
 * was — the roster excludes the mailbox, the organizer lease gate stands the worker down, and
 * the lifecycle fence refuses the un-disable. A mailbox row that has VANISHED does refuse
 * (its writes could only fail on foreign keys anyway).
 *
 * `lost` is the worker's synchronous lock-loss tripwire (`() => lockLost`): once the process
 * has observed losing the advisory lock it must not even open the transaction, because the
 * heartbeat row may still name it for the moment between the loss and the successor's claim.
 */
export function makeSyncWriteFence(
  db: WorkerDb, mailboxId: string, fence: LeaderFence, lost: () => boolean = () => false,
): SyncWriteFence {
  const leaderRow = () => and(
    eq(workerHeartbeats.shardIndex, fence.shardIndex),
    eq(workerHeartbeats.instanceId, fence.instanceId),
    eq(workerHeartbeats.leader, true),
  );
  return {
    lost,
    async stillLeader(): Promise<boolean> {
      if (lost()) return false;
      // Tagged for the same reason the transaction below is: this read is our database, and a
      // failure of it must not be read as the customer's IMAP host refusing a mutation. See
      // `db-fault.ts`.
      const rows = await asDatabaseFault("fence.stillLeader", () =>
        db.select({ shardIndex: workerHeartbeats.shardIndex })
          .from(workerHeartbeats).where(leaderRow()));
      return rows.length > 0;
    },
    async transaction<T>(
      fn: (repo: DrizzleRepo) => Promise<T>,
    ): Promise<{ fenced: true } | { fenced: false; result: T }> {
      if (lost()) return { fenced: true };
      // ── THE OTHER HALF OF THE SYNC LOOP'S DATABASE SURFACE ─────────────────────────────
      //
      // `SyncDeps.repo` is wrapped where the worker builds it; this is the seam that does not go
      // through it — the fence's own `BEGIN`, its two guard statements, and the `COMMIT`. A
      // connection that dies between the claim and the commit throws from HERE, and untagged it
      // was indistinguishable from a mailbox fault: `rt.failures++`, and at `maxSyncFailures` a
      // customer's row saying `status='error'` because our pooler dropped a connection.
      //
      // The callback's own throws are already tagged (it is handed a wrapped repo below) and the
      // tag is idempotent, so a per-message `23505` still arrives as itself under one wrapper and
      // still classifies to the message domain.
      return asDatabaseFault("fence.transaction", () => db.transaction(async (tx) => {
        const w = tx as unknown as WorkerDb;
        const held = await w.select({ id: mailboxes.id }).from(mailboxes)
          .where(eq(mailboxes.id, mailboxId)).for("update");
        if (held.length === 0) return { fenced: true as const };
        const still = await w.select({ shardIndex: workerHeartbeats.shardIndex })
          .from(workerHeartbeats).where(leaderRow());
        if (still.length === 0) return { fenced: true as const };
        // The tx-scoped repo, exactly as `WorkerRepo.transaction` would have built it — the
        // group's writes commit with the leadership verdict or not at all. Wrapped, so a write
        // that fails inside the group names the database as its origin rather than being
        // classified from a code that a dead IMAP host produces identically.
        return {
          fenced: false as const,
          result: await fn(markDatabaseFaults(makeDrizzleRepo(tx as unknown as Tx), "repo")),
        };
      }));
    },
  };
}

/**
 * Record that a mailbox is quarantined AND why — one statement, so `status` and its reason can
 * never disagree. Returns false when the write was FENCED OUT (see the block above): the row is
 * disabled, or this process is no longer the shard's leader.
 *
 * `failed_at` uses `COALESCE`, so it holds the start of the CURRENT outage: a mailbox failing
 * for three days reports three days rather than "just now, again" on every retry.
 * `retry_count` increments IN SQL for the same reason — it is the size of this outage, and it
 * must survive the worker restart that resets the in-memory backoff map. Those two counters
 * answer different questions ("how long has this been broken" vs "when do I retry next") and
 * are ALLOWED to disagree after a deploy; making the column mirror the map would tell a user
 * "attempt 1" about a three-day outage.
 *
 * ── THE DETAIL IS RE-CHECKED HERE, NOT TRUSTED ─────────────────────────────────────────────
 *
 * The header above this section calls these "the ONLY way the worker writes `mailboxes.status`",
 * and that was true of the STATUS and false of the reason: `detail` is a `string | null`, so
 * `{ detail: err.message }` typechecked and was stored verbatim into a column the account owner
 * and the admin console both read. There is no database constraint behind it either. So the
 * allowlist is applied AT THE WRITE, and safety stops depending on every caller remembering to
 * route through {@link mailboxErrorDetail} first. An unrecognised detail is dropped to NULL
 * rather than refused — a mailbox must never stay un-quarantined because its reason was unsafe.
 */
export async function markMailboxFailed(
  db: WorkerDb, mailboxId: string,
  failure: { code: MailboxErrorCode; detail: string | null },
  opts: { fence?: LeaderFence; now?: Date; retryAfter?: Date | null } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes).set({
    status: "error",
    errorCode: failure.code,
    errorDetail: isSafeMailboxErrorDetail(failure.detail) ? failure.detail : null,
    // Mail 0039 — WHEN the leader may next attach this mailbox, in the SAME statement as the
    // status, for the reason the whole of this function is one statement: a row that says
    // `error` beside a stale or absent backoff is a half-truth, and the operator release path
    // reads exactly this column. Passed in rather than computed here because the ladder lives in
    // the worker's quarantine map — this function records a decision, it does not make one.
    //
    // `undefined` leaves the column ALONE, which is not the same as clearing it: a caller that
    // does not know when the next attempt is due must not be able to release a mailbox by
    // omission. Only an explicit `null` clears.
    ...(opts.retryAfter !== undefined ? { retryAfter: opts.retryAfter } : {}),
    // `.toISOString()` + an explicit cast: postgres-js has serialised a bare Date as TEXT in
    // this repository before, and inside a raw `sql` fragment there is no column type to
    // coerce it. The same form `alerts.ts` uses for its threshold comparisons.
    failedAt: sql`coalesce(${mailboxes.failedAt}, ${now.toISOString()}::timestamptz)`,
    retryCount: sql`${mailboxes.retryCount} + 1`,
    // Mail migration 0029: a quarantine is an ANSWER, so the "we declined to serve this" note goes. A row
    // that said both would tell the mailbox's owner "your mailbox rejected the password" and "we could not
    // read the organizer lease" at once, and only one of those can be the reason it is not syncing.
    syncBlockedReason: null, syncBlockedSince: null,
  }).where(lifecycleWhere(mailboxId, opts.fence)).returning({ id: mailboxes.id }));
}

/**
 * Record a VERIFIED recovery: connected, and the reason cleared in the same statement. Returns
 * false when the write was FENCED OUT — the user disconnected the mailbox, or another instance
 * now leads this shard.
 *
 * Atomic with the status flip on purpose — a `status='connected'` row sitting next to a stale
 * `error_code` would be exactly the kind of half-truth this slice exists to remove, and the UI
 * would render "connected" and "the mailbox rejected the password" side by side.
 */
export async function markMailboxConnected(
  db: WorkerDb, mailboxId: string, opts: { fence?: LeaderFence } = {},
): Promise<boolean> {
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes).set({
    status: "connected", errorCode: null, errorDetail: null, failedAt: null, retryCount: 0,
    // Mail 0039, cleared here for the same reason `retry_count` is: a mailbox that has COMPLETED
    // a sync cycle is not in a failure backoff, so a leftover `retry_after` beside `connected`
    // would park it on the next restart — the seed below reads the row, not the map, and would
    // resurrect a backoff that a successful cycle already spent.
    retryAfter: null,
    // Mail migration 0029, and for exactly the reason the four above it are cleared here: a VERIFIED
    // recovery means the mailbox is connected, in the rotation, and has COMPLETED a sync cycle —
    // the non-blocking attach moved that bar off "two inline cycles at attach time" and onto the cycle path, but
    // did not lower it. So nothing is blocking this mailbox by definition, and a leftover
    // `sync_blocked_reason` beside `connected` would be the same half-truth migration 0023 exists to remove,
    // one column over.
    syncBlockedReason: null, syncBlockedSince: null,
  }).where(lifecycleWhere(mailboxId, opts.fence)).returning({ id: mailboxes.id }));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   STANDING DOWN IS NOT FAILING (mail migration 0027)
   ══════════════════════════════════════════════════════════════════════════════════════════

   A mailbox another organizer holds is a mailbox in perfect health that we must stop touching.
   It therefore gets its own write site rather than a `markMailboxFailed` with a creative code:
   `status='error'` would put it in the retry rotation with an exponential backoff, page nobody's
   attention at the right thing, and tell the account's own user their mailbox is broken. It is
   `status='disabled'`, which `loadEnabledMailboxes` already excludes and which `reconcileRoster`
   already detaches — no new teardown machinery, exactly as `ORGANIZER-LEASE-RESUME.md` §2.6 said.

   THE FOUR FAILURE COLUMNS ARE CLEARED IN THE SAME STATEMENT, for the reason
   `markMailboxConnected` clears them: a row that says "organized elsewhere" beside a stale
   "the mailbox rejected the password" is the half-truth 0023 exists to remove.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

import { type MailboxDisabledReason, isMailboxDisabledReason } from "@trafficflow/db";
export type { MailboxDisabledReason };

/**
 * Stand a mailbox down: `disabled`, with the lease reason, atomically. Returns false when the
 * write was FENCED OUT — the mailbox is already disabled, or this instance no longer leads.
 *
 * ── AN UNRECOGNISED REASON IS COERCED, NEVER DROPPED AND NEVER THROWN ──────────────────────
 *
 * `markMailboxFailed` drops an unsafe `error_detail` to NULL, because a mailbox must never stay
 * un-quarantined over a bookkeeping value. The same principle points the other way here. A
 * mailbox must never keep ORGANIZING because its stand-down reason was unrecognised, so the
 * status flip cannot be allowed to fail — and it must not land with `disabled_reason` NULL
 * either, because NULL on this column means "disabled for a reason that is not the lease", which
 * would be a lie the UI reads. So an unrecognised value becomes `organized_elsewhere:unknown`:
 * imprecise, true, and inside the CHECK constraint mail 0027 puts behind the column.
 *
 * The parameter is already a `MailboxDisabledReason`, so this is unreachable from today's tree —
 * it is the guard for the call site nobody has written yet, and it is the reason the constraint
 * can never be the thing that fires.
 */
export async function markMailboxStoodDown(
  db: WorkerDb, mailboxId: string, reason: MailboxDisabledReason,
  opts: { fence?: LeaderFence } = {},
): Promise<boolean> {
  const safe: MailboxDisabledReason =
    isMailboxDisabledReason(reason) ? reason : "organized_elsewhere:unknown";
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes).set({
    status: "disabled",
    disabledReason: safe,
    // Standing down is not failing. See the block above.
    errorCode: null, errorDetail: null, failedAt: null, retryCount: 0,
    // Mail 0029. `disabled_reason` is now the whole answer to "why is this mailbox not syncing",
    // and it is a BETTER answer than any member of the sync-block set: somebody else is organizing
    // it. A stale `lease_unreadable` beside it would be the older, weaker guess about the same
    // mailbox. This is also the write that makes the cycle's stand-down path safe — see the note
    // on `leaseBlocked` in `index.ts`.
    syncBlockedReason: null, syncBlockedSince: null,
    // Mail 0039, for the same reason as the four failure columns above it: standing down is not
    // failing, so there is no attempt to schedule. A leftover backoff on a mailbox somebody else
    // is organizing would also outlive the stand-down — a user who takes this mailbox back to
    // Cloud would find it parked behind a wait that was never about them.
    retryAfter: null,
    // The authorization is spent by definition: we are no longer the organizer, so becoming one
    // again is a new BECOMING and needs a new explicit action (§4, "No seize-back").
    takeoverAuthorizedAt: null,
  }).where(lifecycleWhere(mailboxId, opts.fence)).returning({ id: mailboxes.id }));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   DECLINING TO SERVE IS NEITHER FAILING NOR STANDING DOWN (mail migration 0029)
   ══════════════════════════════════════════════════════════════════════════════════════════

   A third state, and it needed its own pair of writes for the same reason standing down did.

   The founding incident: the first real production mailbox did not sync for half an hour while its
   row said `status='connected'`, `error_code = NULL`, `last_sync_at = NULL`. The worker knew the
   answer the whole time — `attach_lease_unavailable`, once every 30 s — and the only place it
   wrote it was stdout. Three branches behave this way, and the reason none of them may reuse an
   existing write site is the same in all three:

   · `markMailboxFailed` would be WRONG, not merely imprecise. `status='error'` puts the mailbox
     into the retry rotation with an exponential backoff, tells the account's own user their
     mailbox is broken, and shows an operator a fault that is ours. "An infrastructure fault can
     never quarantine a mailbox" is a property `index.ts` maintains by CLASS at four catch sites;
     this write is what lets it stay true and still be legible.
   · `markMailboxStoodDown` would be worse: `disabled` is STICKY (only an explicit human PATCH
     re-enables it), so a transient IMAP hiccup would permanently disconnect a mailbox nobody else
     wants.

   So: `status` IS NOT TOUCHED, and neither are the four failure columns. These two functions write
   exactly two columns and read none, which is what makes them safe to call on a mailbox that is
   `connected`, `error`, mid-quarantine or mid-recovery — the state machine above them is
   untouched, and the four sites that DO own `status` each clear these two in their own statement.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

import { type MailboxSyncBlockReason, isMailboxSyncBlockReason } from "@trafficflow/db";
export type { MailboxSyncBlockReason };
export { isMailboxSyncBlockReason };

/**
 * Record that this process is NOT SERVING a mailbox it knows is expected, and why.
 *
 * Returns false when the write was FENCED OUT — same predicate as every other lifecycle write, so
 * a disabled mailbox and a surrendered leader are both refused. Fenced deliberately even though
 * this touches no lifecycle column: the two columns describe THIS process's relationship to the
 * mailbox, and a surrendered leader's late note about a mailbox somebody else is now serving is
 * exactly as stale as its late failure write would be.
 *
 * ── IDEMPOTENT BY `COALESCE`, AND THAT IS WHY THE CALLER MAY REPEAT IT ─────────────────────
 *
 * `reconcileRoster` calls this on EVERY pass while the block lasts, and the `coalesce` is what
 * makes that free of consequence: `sync_blocked_since` holds the start of the CURRENT block, so a
 * mailbox unserved for three days reports three days instead of "just now, again" every 30
 * seconds. The repeat is not laziness — it is what converges the row when ANOTHER writer clears
 * the columns (a `PATCH /mailboxes/:id` that moves the status does exactly that) while the block
 * is still in force. A write-once design would leave that row silent for the life of the process,
 * which is the bug, restored.
 *
 * `.toISOString()` plus an EXPLICIT CAST, copied verbatim from `markMailboxFailed`: inside a raw
 * `sql` fragment there is no column type to coerce a bare `Date` against, postgres-js binds it as
 * TEXT, and PGlite accepts it happily so the unit suite stays green while production throws.
 * `packages/db/src/alerts.ts:307-317` records that this has bitten twice.
 */
export async function markMailboxSyncBlocked(
  db: WorkerDb, mailboxId: string, reason: MailboxSyncBlockReason,
  opts: { fence?: LeaderFence; now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes).set({
    syncBlockedReason: reason,
    syncBlockedSince: sql`coalesce(${mailboxes.syncBlockedSince}, ${now.toISOString()}::timestamptz)`,
    // NOTHING ELSE. Not `status`, not `error_code`, not `error_detail`, not `failed_at`, not
    // `retry_count`. The absence is the design — see the block above this function.
  }).where(lifecycleWhere(mailboxId, opts.fence)).returning({ id: mailboxes.id }));
}

/**
 * The mailbox is being served again (or is no longer ours to serve): drop the note.
 *
 * Called by `reconcileRoster` only when the row it just read ACTUALLY CARRIES a reason, so the
 * steady state for a healthy mailbox is zero writes per pass rather than one UPDATE per mailbox
 * per 30 seconds.
 *
 * It cannot be folded into `markMailboxConnected`. `attach` ends with
 * `if (mb.status !== "connected") await markRecovered(mb)` — and in this entire scenario `status`
 * IS `connected`, because a declined mailbox was never marked failed. So `markRecovered` never
 * runs, and a clear that lived only inside it would never fire.
 */
export async function clearMailboxSyncBlock(
  db: WorkerDb, mailboxId: string, opts: { fence?: LeaderFence } = {},
): Promise<boolean> {
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes)
    .set({ syncBlockedReason: null, syncBlockedSince: null })
    .where(lifecycleWhere(mailboxId, opts.fence))
    .returning({ id: mailboxes.id }));
}

/**
 * Spend the one-shot takeover authorization, and record that this mailbox is ours again.
 *
 * Called after a gate returns `organize`. `takeover_authorized_at` authorizes ONE becoming, not
 * a standing right: leaving it set would mean a lapse-then-resubscribe months later silently
 * seizes the mailbox back from whatever a human deliberately moved it to, which is exactly the
 * seize-back §4 forbids. `disabled_reason` is cleared with it, so a mailbox a user re-enabled
 * after a stand-down does not carry the old reason while it is being organized again.
 *
 * A no-op UPDATE every cycle would be a write per mailbox per minute for nothing, so the caller
 * only invokes this when there is something to clear.
 */
export async function clearOrganizerStandDown(
  db: WorkerDb, mailboxId: string, opts: { fence?: LeaderFence } = {},
): Promise<boolean> {
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes)
    .set({ disabledReason: null, takeoverAuthorizedAt: null })
    .where(lifecycleWhere(mailboxId, opts.fence))
    .returning({ id: mailboxes.id }));
}

/**
 * Record that these mailboxes completed a sync cycle. THE WRITER `last_sync_at` NEVER HAD.
 *
 * The column was read in three places and written in none:
 *
 *  · `MailboxService.toDTO` → `MailboxDTO.lastSyncAt`, which the (i) panel and Settings →
 *    Mailboxes render. Every mailbox reported "not synced yet" forever, including one
 *    demonstrably syncing.
 *  · `admin-service.ts`'s "seconds since last sync" column — wrong for every mailbox.
 *  · **`packages/db/src/alerts.ts`, and this is the one that bites operations.** The sync-lag
 *    rule measures `coalesce(last_sync_at, created_at)` against a 15-minute threshold. With
 *    the column permanently NULL every mailbox is judged by its CREATION time, so a perfectly
 *    healthy mailbox crosses the threshold 15 minutes after it is connected and stays over it
 *    for the rest of its life. The alert that exists to notice a dead worker would instead
 *    fire for everyone, forever, and be tuned out — which is worse than not having it.
 *
 * The worker already knew the answer: `cycle()` sets `rt.lastSuccessAt` in memory on every
 * successful pass and simply never persisted it. This is that value, made durable.
 *
 * ── EVERY SUCCESSFUL CYCLE, NOT EVERY INGESTED MESSAGE ──────────────────────────────────
 *
 * A cycle that finds no new mail is a SUCCESS: it proves the worker reached the mailbox,
 * authenticated, and got a clean answer. That is exactly the question the lag alert asks, and
 * stamping only on ingest would mean a quiet mailbox looked identical to an unreachable one —
 * the false alarm again, just rarer and therefore more confusing.
 *
 * ── ONE STATEMENT, AND BEST-EFFORT ──────────────────────────────────────────────────────
 *
 * Batched across the whole rotation because it runs once per `pollIntervalMs` (60 s): a single
 * `WHERE id IN (…)` per minute rather than one write per mailbox per minute. The caller
 * ignores failures for the same reason the `markMailboxConnected` recovery write does — the
 * mailboxes ARE serving, and a failed bookkeeping write must not tear that down. The next
 * cycle rewrites it a minute later.
 *
 * ── TWO CALLERS IN `cycle()`, AND THE BATCHING RULE STILL GOVERNS THE STEADY STATE ───────
 *
 * There is now a single-id call INSIDE the rotation loop as well, on a runtime's FIRST completed
 * cycle only. It exists because the loop is serial: the batched write happens after every mailbox
 * of the pass has had its bounded batch, and after `if (stopped) return;` can discard the pass
 * entirely — so a mailbox's very first stamp used to wait on unrelated mailboxes, which is
 * precisely the false `sync_lag` on a healthy first connect that the paragraphs above are about.
 * It costs one extra UPDATE per ATTACH (`attach()` mints `lastSuccessAt: null`), never one per
 * cycle, so the "not one write per mailbox per minute" rule is intact. See the comment at that
 * call site for why its `catch` may not rethrow.
 */
export async function stampMailboxSync(
  db: WorkerDb, mailboxIds: string[], now: Date,
): Promise<void> {
  if (mailboxIds.length === 0) return;
  await db.update(mailboxes).set({ lastSyncAt: now }).where(inArray(mailboxes.id, mailboxIds));
}

/**
 * {@link stampMailboxSync} at the DATABASE's own clock — `last_sync_at = now() - <elapsed>`.
 *
 * The cycle's call sites use this rather than passing `new Date()`, because the pull
 * affordance's honest settle compares this column against `sync_requested_at`, which
 * `MailboxService.requestPull` stamps with SQL `now()`. Two columns compared with each other
 * must come off ONE clock; a worker-host `Date` put the worker's wall clock into that
 * comparison, where any skew either settles a spinner before the scan it claims to report or
 * never settles it at all (2026-08-26 review, round 1 — and the very machine that ran the
 * measurement has a clock minutes off, which is all the argument this needs).
 *
 * ── `backdateMs` — THE STAMP CLAIMS THE SCAN'S START, NEVER ITS FINISH ─────────────────────
 *
 * Round 2 of the same review: a stamp written at COMPLETION claims an instant later than the
 * IMAP read it reports, so a pull request landing inside that gap — after the read, before the
 * bookkeeping — is "settled" by a scan that could not have seen its mail. The caller therefore
 * passes how long ago its scan STARTED (per-visit elapsed for the eager stamp, per-pass elapsed
 * for the batch), and the write is `now() - elapsed`: still the database's clock for the
 * instant, with only a host-measured DURATION subtracted — a duration carries no wall-clock
 * skew. Understating freshness is the safe direction on both consumers: a settle waits for a
 * scan that genuinely began after its request, and the lag alert's 15-minute threshold dwarfs
 * a pass length.
 *
 * The Date-taking form above survives for callers that mean a SPECIFIC instant — the alert
 * tests seed backdated stamps through it.
 */
export async function stampMailboxSyncNow(
  db: WorkerDb, mailboxIds: string[], backdateMs = 0,
): Promise<void> {
  if (mailboxIds.length === 0) return;
  const behind = Math.max(0, Math.round(backdateMs));
  // GREATEST: this writer only ever RAISES the column. The pass-end batch backdates to the
  // PASS's start, and a woken visit inside that pass has already stamped its own, later,
  // visit-start instant — an unconditional write would overwrite the newer claim with the
  // older one, un-settling a pull the eager stamp had just honestly settled (2026-08-26
  // review, round 3). GREATEST ignores a NULL column, so a first stamp still lands.
  //
  // …AND A FUTURE EXISTING VALUE IS REPLACED BY THIS WRITE'S OWN CANDIDATE, because "only ever
  // raises" must not immortalize a lie: a host-clock writer — an older deployment, or
  // `stampMailboxSync`'s Date form — can have planted a stamp in the DATABASE's future, and a
  // bare GREATEST would preserve it against every honest write until the wall clock caught up,
  // settling pulls with no scan behind them and suppressing the lag alert for the whole skew
  // (round 4). Clamping it to `now()` instead (round 4's first cut) was still a lie with a
  // smaller skew: `now()` claims a scan that COMPLETED this instant, which can post-date a pull
  // baseline this write's scan never covered (round 5). The only truthful claim available for a
  // corrupted row is this write's own scan start, so that is what replaces it. A NULL column
  // falls to the ordinary arm, where GREATEST ignores it and the first stamp lands.
  //
  // `behind` is inlined via sql.raw, NOT bound: drizzle maps a bound parameter inside a
  // `set({ lastSyncAt: … })` fragment through the COLUMN's own mapper on some query paths, and
  // PgTimestamp calls `.toISOString()` on what is a plain number — a crash the best-effort
  // catches would swallow into a silently-never-stamped mailbox. The value is
  // `Math.max(0, Math.round(...))` of a host-measured duration, so the inline is a bare integer
  // by construction.
  const candidate = sql`now() - interval '1 millisecond' * ${sql.raw(String(behind))}`;
  await db.update(mailboxes)
    .set({
      lastSyncAt: sql`case
        when ${mailboxes.lastSyncAt} > now() then ${candidate}
        else greatest(${mailboxes.lastSyncAt}, ${candidate})
      end`,
    })
    .where(inArray(mailboxes.id, mailboxIds));
}

/**
 * Stamp `initial_import_completed_at` the FIRST time this mailbox's import has genuinely drained
 * (mail migration 0038) — the per-mailbox floor the client reads as `IS NULL ⇒ still importing`.
 *
 * ── WHY NOT `stampMailboxSync`, AND WHY PER-MAILBOX ─────────────────────────────────────────
 *
 * `last_sync_at` is stamped after every successful cycle whether or not a backlog remains, and it
 * is batched across the whole rotation in one `WHERE id IN (…)`. Both are wrong for this fact.
 * This column must land ONLY once a cycle completed with `hasBacklog === false` — the import has
 * actually drained — and it is a property of ONE mailbox, so it is a single-id write and never
 * shares a statement with another mailbox's progress.
 *
 * ── `IS NULL` IS WHAT MAKES IT ONCE-PER-MAILBOX ─────────────────────────────────────────────
 *
 * The guard is the whole of "stamped once": the first no-backlog cycle sets the column, and every
 * later no-backlog cycle matches zero rows and writes nothing. No read-then-write, so two
 * concurrent cycles cannot both stamp — the WHERE decides it in one statement. Clearing the column
 * back to NULL is the supported way to make the client speak "still importing" again, and the next
 * no-backlog cycle re-stamps it.
 *
 * BEST-EFFORT at the call site, exactly like `stampMailboxSync`: the mailbox is serving, and a
 * failed bookkeeping write must not tear that down. The next no-backlog cycle re-attempts it.
 */
export async function stampInitialImportComplete(
  db: WorkerDb, mailboxId: string, now: Date,
): Promise<void> {
  await db.update(mailboxes)
    .set({ initialImportCompletedAt: now })
    .where(and(eq(mailboxes.id, mailboxId), isNull(mailboxes.initialImportCompletedAt)));
}
