import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import {
  mailboxes, mailboxCredentials, isOrganizerRole, organizerDisplayName, capabilitiesColumn, type Tx,
  organizerKindColumn, closedSetValue,
  type OrganizerRole, type OrganizerKind, type OrganizerState,
  rules,
} from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { workerHeartbeats } from "@trafficflow/db/cloud";
import type { KeyProvider, OAuthTokenProvider } from "@trafficflow/core";
import {
  buildImapAuth, oauthSmtpEndpoint, type ImapAuth, type CredMetaAuth,
} from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { OrganizerIntent } from "@trafficflow/core/adapters/organizer-lease";
import { asDatabaseFault, markDatabaseFaults } from "./db-fault.js";
import type { SyncWriteFence } from "./sync.js";
import { carryDialect } from "@trafficflow/db/dialect";

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
   * Mail 0104. WHAT that press asked for. `takeover` asks for the mailbox whoever holds it;
   * `join` asks only for one nobody is organizing and yields at the fence to a live foreign
   * claim. Cloud's own door writes `takeover`, so every press made here reads that; the field
   * exists because the fence is shared with an install that has no takeover verb. On the roster
   * row for `takeoverAuthorizedAt`'s reason exactly — another process writes the pair.
   */
  takeoverIntent: OrganizerIntent;
  /**
   * Mail 0027. A lease reason left over from a previous stand-down that a human has since
   * re-enabled past. Read only so the gate knows there is something to CLEAR — nothing decides
   * on it. **It gains no new writer in the mailbox-removal design**: a stand-down now writes the ROLE, and
   * `disabled` means tombstone or plan-disable. This column is read for the clear and for nothing
   * else, and existing rows carry it until their next promotion clears it.
   */
  disabledReason: string | null;
  /**
   * Mail 0083. ORGANIZER OR READER — the field the whole roster now turns on. A reader is CONNECTED
   * and SYNCING, so it is on this roster like an organizer and the `status <> 'disabled'` predicate
   * admits it with no change (the migration's backfill put the existing stood-down population here).
   * What branches on it is the attach (a reader creates no folders, runs no kickstart and publishes
   * no profile) and the cycle, which passes it to `runSyncCycle` as `SyncDeps.role`. COERCED at the
   * read, not trusted: an unrecognised value reads as `reader`, because the direction an unreachable
   * state must fail in is "do not organize somebody else's mailbox".
   */
  organizerRole: OrganizerRole;
  /**
   * Mail 0083. WHO holds the lease when we do not — carried on the roster row so the attach can
   * decide whether the holder columns need refreshing without a second query, and so a promotion
   * knows what it is clearing.
   */
  organizedByKind: string | null;
  organizedByName: string | null;
  organizedSince: Date | null;
  organizerState: string | null;
  /**
   * Mail 0089. WHAT the holder offers a reader — the fifth of the roster's holder columns, on
   * `organizedByKind`'s own reason: carried here so the attach seeds `holderSeen` without a
   * second query.
   */
  organizedByCapabilities: string | null;
  /**
   * Mail 0092. WHICH install holds it — the sixth holder column, on the roster because the reader
   * peek writes only on a CHANGE detected by comparing this snapshot against the folder. A column the
   * snapshot does not carry cannot be compared, so cannot be found stale, so is never written — which
   * is how it shipped: every row before 0092 had a NULL id and five holder columns already agreeing
   * with the folder, so the compare returned early every cycle and the id stayed NULL for ever. NULL
   * fails closed in the release arm, so the hand-back was refused permanently on exactly the mailboxes
   * the feature was built for, while a freshly claimed row worked and every guard stayed green.
   */
  organizedByInstallId: string | null;
  /**
   * Mail 0083. When a human asked THIS install to organize this mailbox. NULL means nobody has —
   * a consent-less reader, which is what `POST /mailboxes` now creates. Read by the attach so a
   * mailbox nobody has consented to organize is never promoted by an empty `ohmail/_meta`.
   */
  organizeConsentedAt: Date | null;
  /**
   * Mail 0088. THE PERSON ASKED THIS INSTALL TO STOP ORGANIZING THIS MAILBOX AND KEEP THE MAIL.
   *
   * On the roster row for `takeoverAuthorizedAt`'s reason exactly: it is written by ANOTHER
   * process while this one is already organizing, so a value read once at attach would leave the
   * press doing nothing until the worker restarted. The gate honours it before it reads the lease
   * at all — reading the lease first would renew a claim this install is about to delete.
   */
  releaseRequestedAt: Date | null;
  /**
   * Mail 0029. What the row currently says about why this mailbox is not being synced. READ SO THE
   * WORKER KNOWS WHETHER THERE IS ANYTHING TO CLEAR, and for no other purpose — nothing decides on it,
   * like `disabledReason` above. It is in this narrow projection rather than re-read on demand because
   * of the trap the alternative walks into: `attach` ends with `if (mb.status !== "connected") await
   * markRecovered(mb)`, and in the whole sync-blocked scenario `status` IS `connected`, so
   * `markRecovered` never runs and never clears. Without this column the worker could only clear for
   * every healthy mailbox on every pass, or never clear at all.
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
   * Mail 0039. WHEN the leader may next attach this mailbox, or NULL for "no backoff in force". THIS
   * ONE IS DECIDED ON, unlike the two above, and it is the only column in this projection that is. It
   * makes a quarantine survive a restart and — the point of the whole column — releasable by somebody
   * who is not this process. The in-memory `quarantine` map is still the ladder; this is its durable
   * mirror, and the roster gate prefers it whenever the durable write for that mailbox actually
   * landed. A worker that reads NULL here for a mailbox it believes it quarantined has been told by an
   * operator to try again now.
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
 * Which mailboxes THIS process is responsible for. There is DELIBERATELY no account filter.
 * `TF_ACCOUNT_ID` used to narrow this, so a value left in the production environment silently
 * un-synced every OTHER account — the silently-unsynced-second-account defect, which a loud log line
 * does not remediate. The roster is now, by construction, the shard's full duty; `TF_ACCOUNT_ID` is
 * bootstrap-only (it pairs with `TF_MAILBOX_ID` to seed the legacy env mailbox and scopes the
 * single-mailbox reconcile backstop). `shards`/`shardIndex` are the shard SEAM (shipped `shards = 1`):
 * with `shards > 1` each process serves a DISJOINT slice hashed on `account_id`, so the per-account
 * seq row-lock and the per-shard leader lock still serialize one account to one process.
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
 * `hashtext` is int4 and CAN be negative, so `%` alone would never match a positive shardIndex for
 * half the accounts — normalize into [0, shards). Postgres-internal and stable within a major
 * version: re-sharding is a deploy decision, not runtime. PERFORMANCE NOTE (for when shards > 1
 * ships): this predicate is not index-supported, so a sharded deployment seq-scans `mailboxes` once
 * per roster pass — free at beta scale, but before shards > 1 ships add an expression index on
 * `((hashtext(account_id::text) % n + n) % n) WHERE status <> 'disabled'` for the deployed `n`, or
 * materialize a `shard` column maintained by the mailbox writer.
 */
function shardPredicate(shards: number, shardIndex: number): SQL {
  return sql`((hashtext(${mailboxes.accountId}::text) % ${shards}) + ${shards}) % ${shards} = ${shardIndex}`;
}

/**
 * Which accounts the roster must skip — composed by the host, absent on a deployment that meters
 * nothing. It used to be one query over this database's own subscription and suspension rows, shared
 * with the API side so the two could not disagree about which row is an account's current one. Those
 * rows belong to whoever operates metering now, and the entitlements port answers per account rather
 * than in bulk — so the reader is a parameter, and ABSENT means NO ACCOUNT IS PARKED: every enabled
 * mailbox syncs, which is a self-hosted install's truth and the fail-open direction, since a missing
 * reader can only sync more and never drop a customer.
 */
export type ParkedAccountsReader =
  (accountIds: readonly string[], now: Date) => Promise<Set<string>>;

/**
 * Every syncable mailbox in the selection: anything not soft-disabled (`status != 'disabled'`) whose
 * account is not parked, oldest first so the `maxMailboxes` cap truncates DETERMINISTICALLY (the same
 * processes keep the same mailboxes across restarts). A quarantined mailbox (`status='error'`) IS
 * returned — quarantine is a retry state, not a terminal one; the worker's per-mailbox backoff
 * decides when to try it again. The parking gate is {@link ParkedAccountsReader}, supplied by the
 * host. Dropping an account here is not destructive: `reconcileRoster` detaches its runtimes and
 * leaves the rows alone, so an account that comes back is straight on the next pass with nothing to migrate.
 */
export async function loadEnabledMailboxes(
  db: WorkerDb, selection: MailboxSelection = {}, now: Date = new Date(),
  parkedAccounts?: ParkedAccountsReader,
): Promise<EnabledMailbox[]> {
  const { shards, shardIndex } = validateShard(selection);

  const filters: SQL[] = [ne(mailboxes.status, "disabled")];
  if (shards > 1) filters.push(shardPredicate(shards, shardIndex));

  const rows = await db
    .select({
      id: mailboxes.id, accountId: mailboxes.accountId,
      provider: mailboxes.provider, address: mailboxes.address, status: mailboxes.status,
      takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
      // Mail 0104 — the VERB behind the stamp, in the same statement as the stamp.
      takeoverIntent: mailboxes.takeoverIntent,
      disabledReason: mailboxes.disabledReason,
      organizerRole: mailboxes.organizerRole,
      organizedByKind: mailboxes.organizedByKind,
      organizedByName: mailboxes.organizedByName,
      organizedSince: mailboxes.organizedSince,
      organizerState: mailboxes.organizerState,
      organizedByCapabilities: mailboxes.organizedByCapabilities,
      organizedByInstallId: mailboxes.organizedByInstallId,
      organizeConsentedAt: mailboxes.organizeConsentedAt,
      releaseRequestedAt: mailboxes.releaseRequestedAt,
      syncBlockedReason: mailboxes.syncBlockedReason,
      retryAfter: mailboxes.retryAfter,
      retryCount: mailboxes.retryCount,
      smtpMaxSizeBytes: mailboxes.smtpMaxSizeBytes,
    })
    .from(mailboxes)
    .where(and(...filters))
    .orderBy(asc(mailboxes.createdAt), asc(mailboxes.id));

  const ids = [...new Set(rows.map((r) => r.accountId))];
  const parked = parkedAccounts && ids.length > 0
    ? await parkedAccounts(ids, now)
    : new Set<string>();
  return rows
    .filter((r) => !parked.has(r.accountId))
    .map((r) => ({
      accountId: r.accountId, mailboxId: r.id, provider: r.provider, address: r.address, status: r.status,
      takeoverAuthorizedAt: r.takeoverAuthorizedAt ?? null,
      // COERCED, never trusted — `join` is the safe direction, as `reader` is below.
      takeoverIntent: r.takeoverIntent === "takeover" ? "takeover" : "join",
      disabledReason: r.disabledReason ?? null,
      // COERCED, never trusted — see the field. `reader` is the safe direction.
      organizerRole: isOrganizerRole(r.organizerRole) ? r.organizerRole : "reader",
      organizedByKind: r.organizedByKind ?? null,
      organizedByName: r.organizedByName ?? null,
      organizedSince: r.organizedSince ?? null,
      organizerState: r.organizerState ?? null,
      organizedByCapabilities: r.organizedByCapabilities ?? null,
      organizedByInstallId: r.organizedByInstallId ?? null,
      organizeConsentedAt: r.organizeConsentedAt ?? null,
      releaseRequestedAt: r.releaseRequestedAt ?? null,
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
  {
    accountId: string; status: string; takeoverAuthorizedAt: Date | null;
    /** Mail 0104 — the VERB behind the stamp; the backstop runs the same gate the roster does. */
    takeoverIntent: OrganizerIntent;
    disabledReason: string | null;
    /**
     * Mail 0090. The SALT of the request key's derivation, so the backstop derives the same key
     * every other install does — an address is public and stable, and its job here is to keep two
     * mailboxes that share a password from sharing a signing key.
     */
    address: string;
    /** Mail 0083. The reconcile backstop is an ORGANIZER pass and must refuse a reader row. */
    organizerRole: OrganizerRole;
    /**
     * Mail 0088. AND IT MUST REFUSE A MAILBOX SOMEBODY HAS ASKED IT TO STOP ORGANIZING, which the
     * role above cannot tell it: a pending release deliberately leaves the row an `organizer`
     * until the gate that performs the release runs.
     */
    releaseRequestedAt: Date | null;
  }
  | null
> {
  const rows = await db
    .select({
      accountId: mailboxes.accountId, status: mailboxes.status,
      takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
      takeoverIntent: mailboxes.takeoverIntent,
      disabledReason: mailboxes.disabledReason,
      organizerRole: mailboxes.organizerRole,
      releaseRequestedAt: mailboxes.releaseRequestedAt,
      address: mailboxes.address,
    })
    .from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
  const r = rows[0];
  if (!r) return null;
  // COERCED, `reader` on anything unrecognised — see `EnabledMailbox.organizerRole`.
  return {
    ...r,
    organizerRole: isOrganizerRole(r.organizerRole) ? r.organizerRole : "reader",
    takeoverIntent: r.takeoverIntent === "takeover" ? "takeover" : "join",
  };
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
  // An oauth mailbox has no `smtp` row, and it still has a submission endpoint. One refresh token
  // covers both transports, so the connect flow stores no second row and the submission
  // host/port/secure live in the imap row's `meta.smtp`. Returning `undefined` for `smtp` — which is
  // what this did — told every caller "this mailbox cannot submit", and the one caller that believed
  // it was the `SIZE` back-fill: an oauth mailbox was reported as having no SMTP credentials and never
  // learned what its server accepts, on ANY host. The `auth` handed back is `imap.auth` ITSELF, not a
  // second assembly of it (same token callback, same access-token cache, same rotated-refresh write) —
  // `makeSendAdapter`'s resolution on the API host, with coordinates from the shared `oauthSmtpEndpoint`.
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

/* Why a mailbox failed (mail 0023). `status` used to be the ENTIRE record of a failure. In one
   disk-full incident the fault quarantined a real production mailbox and the only thing anyone could
   read afterwards was `status='error'` — the diagnostic lived in the worker's memory and a log line,
   and the process had since restarted; Settings said "Sync failed" and the admin console's
   `lastError` was a hardcoded `null` with a comment apologising. These two functions are now the
   ONLY way the worker writes `mailboxes.status`. The former `setMailboxStatus(db, id, status)` is
   deliberately gone: a generic status setter is a call site that can flip a mailbox to `error` and
   forget the reason, and the whole point of this slice is that such a call site should not exist. */

/**
 * The failure taxonomy is defined ONCE, in `@trafficflow/db` beside the column it constrains
 * — it used to be written out here, again in `services/dto/types.ts`, and again in a
 * comment on the column, with nothing keeping the three in step. Re-exported so this module's
 * existing importers do not have to care where it moved.
 */
import type { MailboxErrorCode } from "@trafficflow/db";
export type { MailboxErrorCode };

/**
 * The evidence sets and the `error_detail` allowlist moved to `@trafficflow/db` for one reason:
 * the ADMIN PROJECTION has to ask the same set the write door asks, and a set that lives in the
 * worker is unreachable from `@trafficflow/services`. Classification stays here — which errno
 * means `connect` is IMAP judgement — and re-exports keep this module's importers unchanged.
 */
import {
  CONNECT_ERRNOS, SERVER_UNAVAILABLE_CODES, SERVER_UNAVAILABLE_RESPONSE_CODES,
  TIMEOUT_ERRNOS, STORAGE_SQLSTATES, CERT_CODES,
  MAILBOX_ERROR_DETAIL_MAX, MAILBOX_ERROR_DETAIL_TOKENS, isSafeMailboxErrorDetail,
  staffChannelValue,
} from "@trafficflow/db";
export { MAILBOX_ERROR_DETAIL_MAX, MAILBOX_ERROR_DETAIL_TOKENS, isSafeMailboxErrorDetail };

/** Where the throw came from. It decides only the FALLBACK, never a positive classification. */
export type MailboxErrorPhase = "attach" | "sync";

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
 * Classify a throw into {@link MailboxErrorCode}. IT MAY READ THE MESSAGE. IT MAY NOT STORE IT.
 * Everything structural is preferred (`err.code`, imapflow's `authenticationFailed` and
 * `serverResponseCode`) and one narrow message probe remains for authentication, because a rejected
 * password is the commonest real failure and several servers report it with no structured marker; that
 * probe is safe because its OUTPUT is a seven-value enum ({@link mailboxErrorDetail} is where the
 * storage rule lives). The `authenticationFailed` flag now sits BELOW the two named refusal sets and
 * the errno probe, not above them: imapflow stamps it in the LOGIN catch unconditionally, so it means
 * "LOGIN did not succeed", not "credentials rejected", and reading it first rendered a provider's busy minute as "the mailbox rejected the password" and quarantined on the first dial. `OVERQUOTA` stays below it, deliberately.
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

/**
 * The ONLY value that may be written to `mailboxes.error_detail`. NEVER `err.message`, `err.stack`,
 * or server free-text. This column is read by the account's own user AND the admin console, so what
 * goes in it is an account-isolation question before a usability one: a throw out of `runSyncCycle`
 * can embed RFC822 header bytes (a sender, a subject), and a failed login's server text can echo the
 * login argument. `packages/core/src/log.ts` already settled the same question for every log line
 * (`err` serialised to CLASS + CODE, never message + stack); this inherits that contract. The detail
 * is a MEMBERSHIP test against {@link MAILBOX_ERROR_DETAIL_TOKENS}, never a shape test — see the
 * block above that Set for the attacker-chosen token a shape test admits.
 */
export function mailboxErrorDetail(err: unknown): string | null {
  for (const candidate of [responseCodeOf(err), codeOf(err)]) {
    if (isSafeMailboxErrorDetail(candidate)) return candidate.slice(0, MAILBOX_ERROR_DETAIL_MAX);
  }
  return null;
}

/* Fencing the two lifecycle writes. Both used to be `WHERE id = ?` and nothing else —
   last-writer-wins across two boundaries the worker does not control. A LEADER HANDOFF: worker A
   loses its lock mid-flight, worker B acquires the shard, and A's late write lands, so completion
   ORDER decides the persisted truth (a healthy mailbox quarantined, or a dead one reported
   connected). THE USER'S OWN DISCONNECT: a recovery from an `error` snapshot lands after the user
   disconnected the mailbox and writes `connected`, putting it back on the roster — the user's most
   consequential action silently undone. Both are closed with a predicate IN the statement:
   `status <> 'disabled'` (the worker never has authority to un-disable) and an EXISTS against
   `worker_heartbeats` for (shard, instance, leader) — the leader epoch, one definition, not two.
   `.returning()` rather than a driver row count, so "was I fenced out?" is answerable everywhere. */

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
 * Run a fenced lifecycle write — the row is CLAIMED first, and only then is the fence asked.
 * `leaderStillOurs` is an UNCORRELATED `EXISTS` over another table, and READ COMMITTED answers such a
 * subquery, when the statement carrying it has to WAIT, with the leadership the statement BEGAN with —
 * `worker_heartbeats` is another row. So a single fenced `UPDATE` that blocks on the mailbox row is
 * answered with stale leadership: the fence FAILS OPEN in exactly the handover it exists for (measured
 * against real Postgres). The fix is one transaction, two statements: a bare `SELECT … FOR UPDATE`
 * absorbs the lock wait and asserts nothing, then the fenced `UPDATE` takes a FRESH snapshot at its
 * own start (after the wait) and cannot block, because we already hold the only row it names. Unfenced callers are unchanged — one statement, no transaction, nothing to be raced out of.
 */
async function applyFenced(
  db: WorkerDb, mailboxId: string, fence: LeaderFence | undefined,
  write: (db: WorkerDb) => Promise<Array<{ id: string }>>,
  /**
   * A CONSEQUENCE OF THE WRITE, IN THE SAME TRANSACTION — run only if the write landed.
   *
   * Present only for the promotion (see {@link clearOrganizerStandDown}), whose consequence must
   * not be able to land without the role flip or the flip without it. Its presence FORCES the
   * transaction even with no fence, because "same transaction" is the whole property: two
   * statements outside one would leave a role flipped with its consequence missing whenever the
   * process dies between them, and that is a state nothing would ever repair.
   */
  also?: (db: WorkerDb) => Promise<void>,
): Promise<boolean> {
  if (!fence && !also) return (await write(db)).length > 0;
  return db.transaction(async (tx) => {
    // The claim. `.for("update")` is the point of the statement; the columns are irrelevant.
    // A row that has vanished is refused here rather than by the write that follows.
    if (fence) {
      const held = await tx.select({ id: mailboxes.id }).from(mailboxes)
        .where(eq(mailboxes.id, mailboxId)).for("update");
      if (held.length === 0) return false;
    }
    // The same cast the services layer uses between a `Db` and a `Tx`: the transaction exposes
    // the query surface these writers use, and typing every one of them against both would say
    // nothing the callers do not already state.
    const landed = (await write(tx as unknown as WorkerDb)).length > 0;
    if (landed && also) await also(tx as unknown as WorkerDb);
    return landed;
  });
}

/**
 * A promotion re-opens every owed retro walk on the account — one statement, at the event.
 * `rules.retro_cursor` is the resume point of "apply this rule to existing mail" (the last committed
 * page's `messages.id`), and `messages.id` is a RANDOM uuid, so that cursor is a fence across the id
 * space, trustworthy only for the set of mailboxes the walk could see when it was written. A promotion
 * changes that set: a walk that ran while this mailbox was a READER offered none of its rows, so the
 * ones sorting BELOW the fence stay behind the walk and the next pass reads a short page as the end,
 * stamps `retro_done_at`, and never files the older half. So the fence comes down HERE, where the set
 * changes — `retro_requested_at IS NOT NULL AND retro_done_at IS NULL` is the one definition of owed work. A newly CONNECTED mailbox is deliberately not here: its mail is routed by the rule at arrival.
 */
export async function clearOwedRetroFences(db: WorkerDb, mailboxId: string): Promise<void> {
  await db.update(rules)
    .set({ retroCursor: null })
    .where(sql`${rules.retroRequestedAt} is not null
                 and ${rules.retroDoneAt} is null
                 and ${rules.accountId} = (
                   select mb.account_id from ${mailboxes} mb where mb.id = ${mailboxId}
                 )`);
}

/**
 * The same fence, over the mail-bearing writes — `SyncDeps.fence` for one mailbox. `applyFenced`
 * covers the two LIFECYCLE writes; this covers everything `runSyncCycle` persists (`messages` and
 * instances, folder cursors, `change_log`, `folder_state`/`flag_state`, `message_failures`,
 * `audit_log`) with the SAME leadership definition and the SAME two-statement shape, for the same
 * EvalPlanQual reason: a bare `SELECT … FOR UPDATE` on the MAILBOX row absorbs the lock wait (two
 * workers contending for one mailbox meet HERE, at a statement allowed to wait), then the leadership
 * check is its own statement with a fresh snapshot. The row's DISABLED status is deliberately NOT part
 * of this fence, unlike `lifecycleWhere`: a refusal here quiesces the whole instance (the right response to a lost shard, the wrong one to one mailbox switched off). `lost` is the synchronous tripwire.
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
      // The other half of the sync loop's database surface. `SyncDeps.repo` is wrapped where the
      // worker builds it; this is the seam that does not go through it — the fence's own `BEGIN`, its
      // two guard statements, and the `COMMIT`. A connection that dies between the claim and the
      // commit throws from HERE, and untagged it was indistinguishable from a mailbox fault
      // (`rt.failures++`, and at `maxSyncFailures` a customer's row saying `error` because our pooler
      // dropped a connection). The callback's own throws are already tagged (it is handed a wrapped
      // repo) and the tag is idempotent, so a per-message `23505` still arrives as itself under one
      // wrapper and classifies to the message domain.
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
          // `carryDialect`, not the bare `tx`: the transaction object does not inherit the
          // connection's dialect brand, and a repository built straight from it refuses on its
          // first locking statement — which is every write this fence exists to group.
          result: await fn(
            markDatabaseFaults(makeDrizzleRepo(carryDialect(db, tx) as unknown as Tx), "repo"),
          ),
        };
      }));
    },
  };
}

/**
 * Record that a mailbox is quarantined AND why — one statement, so `status` and its reason can never
 * disagree. Returns false when the write was FENCED OUT. `failed_at` uses `COALESCE`, so it holds the
 * start of the CURRENT outage (three days rather than "just now, again" on every retry), and
 * `retry_count` increments IN SQL for the same reason — it is the size of this outage and must survive
 * the restart that resets the in-memory backoff map. Those two counters answer different questions and
 * are ALLOWED to disagree after a deploy. THE DETAIL IS RE-CHECKED HERE: `detail` is `string | null`,
 * so `{ detail: err.message }` typechecked and was stored verbatim into a column both the account
 * owner and admin console read, with no database constraint behind it — so the allowlist is applied AT THE WRITE, and an unrecognised detail is dropped to NULL rather than refused.
 */
export async function markMailboxFailed(
  db: WorkerDb, mailboxId: string,
  failure: { code: MailboxErrorCode; detail: string | null },
  opts: { fence?: LeaderFence; now?: Date; retryAfter?: Date | null } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes).set({
    status: "error",
    // The column is TEXT with no CHECK, so `MailboxErrorCode` is a compiler claim and a cast
    // ends it. The door REFUSES a non-member rather than coercing: a code we did not choose
    // means the caller has a defect, and writing `unknown` over it would hide that.
    errorCode: staffChannelValue("mailboxes.error_code", failure.code),
    // COERCES, and it is the one channel in the registry that does — see `staffChannelValue`'s
    // block. The candidate comes off the wire, so refusing would let a mail server fail the
    // quarantine write by answering with a word we do not know.
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

/* Standing down is not failing (mail 0027). A mailbox another organizer holds is a mailbox in perfect
   health that we must stop touching. It gets its own write site rather than a `markMailboxFailed`
   with a creative code: `status='error'` would put it in the retry rotation with an exponential
   backoff, page nobody's attention, and tell the account's user their mailbox is broken. It is
   `status='disabled'`, which `loadEnabledMailboxes` already excludes and `reconcileRoster` already
   detaches — no new teardown machinery. THE FOUR FAILURE COLUMNS ARE CLEARED IN THE SAME STATEMENT,
   for the reason `markMailboxConnected` clears them: a row that says "organized elsewhere" beside a
   stale "the mailbox rejected the password" is the half-truth 0023 exists to remove. */

import { type MailboxDisabledReason, isMailboxDisabledReason } from "@trafficflow/db";
export type { MailboxDisabledReason };

/**
 * Stand a mailbox down: `organizer_role='reader'` plus the holder columns, atomically. Returns false
 * when FENCED OUT. This used to write `disabled` with the lease reason; mail 0083 moved the decision
 * onto the role and left `disabled_reason` with no writer here. An unrecognised reason is COERCED,
 * never dropped and never thrown: `markMailboxFailed` drops an unsafe `error_detail` to NULL because a
 * mailbox must never stay un-quarantined over a bookkeeping value, and the same principle points the
 * other way — a mailbox must never keep ORGANIZING because its stand-down reason was unrecognised, and
 * it must not land with `disabled_reason` NULL (which means "disabled for a non-lease reason", a lie
 * the UI reads). So an unrecognised value becomes `organized_elsewhere:unknown`: imprecise, true, and inside mail 0027's CHECK constraint. The parameter is already a `MailboxDisabledReason`, so this guards a call site nobody has written.
 */
export interface StandDownHolder {
  /** The winning claim's kind. `null` when the claim was malformed — 'unknown' is then written. */
  kind?: OrganizerKind | null;
  /**
   * `X-Ohmail-Install-Id` — WHICH install, as opposed to which KIND of one. The kind is one of three
   * words and answers "what sort of thing holds this mailbox"; it was read as "is this us", which is
   * only the same question when there is one install per kind. `lease.ts` scopes the Cloud id by
   * environment precisely so that it is not (two Cloud deployments over one mailbox is a designed-for
   * state), and the claim removal matches on this id, so this is the unit the row must carry for the
   * API tier to decide on the same one. `null` when the claim was malformed or carried none; that
   * writes NULL, which every caller must read as NOT ours.
   */
  installId?: string | null;
  /** `X-Ohmail-Display-Name`, header-safe and capped at the write. */
  displayName?: string | null;
  /** `X-Ohmail-Claimed-At` — when they became the organizer. */
  claimedAt?: Date | null;
  /** The lease's occupancy as this read saw it. */
  state?: OrganizerState | null;
  /**
   * `X-Ohmail-Capabilities` off the winning claim (0.14.1) — what the holder offers a reader.
   * `undefined`/`null`/`[]` all write NULL (via {@link capabilitiesColumn}), which reads as "we
   * have not looked" or "nothing offered" — the same fail-safe absence {@link state}'s own NULL
   * already carries.
   */
  capabilities?: readonly string[] | null;
}

export async function markMailboxStoodDown(
  db: WorkerDb, mailboxId: string, reason: MailboxDisabledReason,
  opts: {
    fence?: LeaderFence; by?: StandDownHolder; now?: Date;
    /**
     * A CONSEQUENCE OF THE DEMOTION, IN THE SAME TRANSACTION — {@link applyFenced}'s `also`,
     * exposed here for the one caller that has one: the stand-down's HANDOVER of pending local
     * moves. Two transactions could leave a demotion with its handover missing (every not-yet-
     * exported intent stranded on a reader for ever) or a handover with its demotion missing
     * (requests minted for a mailbox this install still believes it organizes). It also runs
     * after `applyFenced`'s `FOR UPDATE`, which is what makes the handover's own read complete —
     * see `exportPendingMovesOnStandDown`.
     */
    also?: (db: WorkerDb) => Promise<void>;
  } = {},
): Promise<boolean> {
  const safe: MailboxDisabledReason =
    isMailboxDisabledReason(reason) ? reason : "organized_elsewhere:unknown";
  // The kind, from the CLAIM where there is one and from the reason otherwise. The fallback keeps the
  // column populated for a malformed claim, whose reason is the honest `organized_elsewhere:unknown`.
  // THEY DO NOT ALWAYS AGREE, and this used to say they did ("`readMailboxLease` derives the reason
  // from the same claim"). The unrankable arm is the counter-example: a claim from a FUTURE PROTOCOL
  // parses its `X-Ohmail-Organizer-Kind` header perfectly (`cloud`, say) while the verdict is
  // `organized_elsewhere:unknown`, because what could not be ranked was the protocol, not the kind —
  // and the row is better for the disagreement (the banner names "ohmail Cloud (next)"). What is not
  // acceptable is a comment asserting an equality the code does not maintain, so it is stated as a
  // preference for the claim's own answer, which is what the expression encodes.
  // THROUGH THE WRITE DOOR, not a cast: the middle term is a word cut out of a reason string,
  // so the assertion was making a claim the expression cannot keep. `organized_by_kind` is a
  // widenable set, which the device store carries no CHECK for at all — this is the refusal on
  // both dialects, and an unrankable peer becomes `unknown` exactly as it did.
  const kind = organizerKindColumn(opts.by?.kind ?? safe.split(":")[1]);
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes).set({
    // Mail 0083: the role, not the status. This used to write `status: "disabled"` plus the reason,
    // and the mailbox left the roster. A loser is now a READER — connected, syncing, mirroring — so
    // the status is untouched and the role carries the whole decision. Four consequences, each once
    // handled by the status flip and now by this column: `loadEnabledMailboxes` keeps returning the
    // row, so the mirror keeps growing; `closeStoodDownAppointments` keys on `organizer_role =
    // 'reader'` (it used to key on `disabled` + a reason, which nothing writes now); `disabled` goes
    // back to meaning tombstone or plan-disable, with no second reading; and `disabled_reason` gains
    // NO writer here — the column stays for the rows that carry it and for the clear, nothing new.
    organizerRole: "reader",
    /* ── THE ASK GOES WITH THE ROLE IT WAS MADE UNDER ──────────────────────────────────────
     *
     * `release_requested_at` outlived every role change but the release's own, so a takeover left
     * the loser's standing "stop organizing" on a row that now names the WINNER — one row carrying
     * one install's request while another organizes the mailbox. The read side already refuses to
     * treat the stamp as an authority on who organizes, so nothing false renders today; the write
     * side still let the two disagree, which a later reader can only be right about by accident.
     * Every writer that makes the statement untrue clears it in the same statement. */
    releaseRequestedAt: null,
    organizedByKind: kind,
    // Mail 0092 — WHICH install, beside WHAT kind. See `StandDownHolder.installId`.
    organizedByInstallId: opts.by?.installId ?? null,
    // Header-safe and capped at the write site — this is a CUSTOMER'S MACHINE NAME arriving out
    // of another install's RFC822 header. Empty becomes NULL: "the claim did not say" is a
    // different fact from "the claim named the empty string", and only one of them renders.
    organizedByName: organizerDisplayName(opts.by?.displayName ?? null),
    organizedSince: opts.by?.claimedAt ?? null,
    // The occupancy as THIS read saw it. Persisted now  because a reader cycle
    // refreshes it every pass — see the column's own note for why `lease.ts` argued it must not
    // be, and why that premise moved.
    organizerState: opts.by?.state ?? null,
    // Mail 0089 — the fifth holder column, on the same read. Whether a request may be OFFERED to
    // this reader rests on this and `organizerState` together (`readRequestEligibility`).
    organizedByCapabilities: capabilitiesColumn(opts.by?.capabilities),
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
    // Mail 0088 — and BEING BEATEN IS NOT RELEASING. A row that carried both would report the
    // quieter of the two events to a person whose mailbox somebody else has just taken, and the
    // claim-back screen would name no previous holder on the one occasion there is one.
    organizerReleasedAt: null,
    // Mail 0088: the organizing situation just changed, so say when. One of the five writers of the
    // (role, state, holder) triple, and every one stamps this in the SAME statement as the fact it is
    // announcing — not a second write, for the reason the holder columns ride this statement: a row
    // that says `reader` while its event instant still describes the previous situation is a client
    // rendering yesterday's sentence, with nothing anywhere to notice it. `organizer_event_seen_at` is
    // deliberately NOT cleared — the notice is `event_at > seen_at`, so advancing `event_at` is the
    // whole of "show this again", and clearing the acknowledgement would lose the record of an older
    // dismissal for no gain.
    organizerEventAt: opts.now ?? new Date(),
  }).where(lifecycleWhere(mailboxId, opts.fence)).returning({ id: mailboxes.id }), opts.also);
}

/**
 * The person asked this install to stop organizing this mailbox, and keep the mail (0.14.1) — the
 * third way a row stops being an organizer, and the first nobody else caused (`markMailboxStoodDown`
 * names a winner; `MailboxService.delete` retires the row; this keeps credentials, consent and mirror
 * and the next cycle is a READER cycle). EVERY HOLDER COLUMN IS CLEARED, the difference from a
 * stand-down: there is no winner, so leaving them would put "organized by ohmail Cloud" on a mailbox
 * nothing is organizing — the banner lying just as the person pressed the button that stops it.
 * `organizer_state` goes to NULL so `standDownMemory` reads reader/consented/no-holder/no-state as the
 * RELEASED arm and answers `null`. The release request is SPENT here (like `takeover_authorized_at`), or it would answer every later gate and an install asked to stop could never be asked to start. FENCED like every lifecycle write.
 */
export async function markMailboxReleased(
  db: WorkerDb, mailboxId: string, opts: { fence?: LeaderFence; now?: Date } = {},
): Promise<boolean> {
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes).set({
    organizerRole: "reader",
    // Nobody holds it. See the header — this is the whole difference from a stand-down.
    organizedByKind: null,
    // Mail 0092 — nobody holds it, so no id names anybody.
    organizedByInstallId: null,
    organizedByName: null,
    organizedSince: null,
    organizerState: null,
    // Mail 0089 — the fifth holder column. Nobody holds it, so nobody offers anything.
    organizedByCapabilities: null,
    // Spent. One ceasing, not a standing refusal.
    releaseRequestedAt: null,
    // AND THE RECORD THAT IT HAPPENED. The ask is gone; without this the row is byte-identical to a
    // stood-down reader whose winner has since gone away, and `standDownMemory` would have to
    // derive "released" from an absence three other writers also produce. See the column.
    organizerReleasedAt: opts.now ?? new Date(),
    // AND ANY UNSPENT TAKEOVER GOES WITH IT. The two stamps are contradictory instructions about
    // the same mailbox, and a release that left a becoming authorized would be promoted straight
    // back by the very next gate — the control undoing itself, which is this feature's own named
    // risk. The `FOR UPDATE` on the service side keeps the two presses ordered; this is what makes
    // the LOSING order harmless rather than merely unlikely.
    takeoverAuthorizedAt: null,
    // Standing down is not failing, and neither is stopping on purpose. Same four columns, same
    // argument as the stand-down above.
    errorCode: null, errorDetail: null, failedAt: null, retryCount: 0,
    syncBlockedReason: null, syncBlockedSince: null,
    retryAfter: null,
    // Mail 0088 — the fifth writer of the triple. See `markMailboxStoodDown`'s note.
    organizerEventAt: opts.now ?? new Date(),
  }).where(and(
    lifecycleWhere(mailboxId, opts.fence),
    /* THE REQUEST MUST STILL BE STANDING. A worker carries a release decision from the start of
       its cycle to the write at the end of it, and in between the person can press "Organize
       here" — which cancels the request and writes a takeover. Without this the stale write won:
       it cleared the newer takeover and released a mailbox against the person's LAST press, which
       is the control undoing itself. Requiring the stamp it was authorised by to still be there
       makes the losing order harmless rather than merely unlikely — the same argument the
       `FOR UPDATE` on the service side already makes for two presses racing each other. */
    isNotNull(mailboxes.releaseRequestedAt),
  )).returning({ id: mailboxes.id }));
}

/* Declining to serve is neither failing nor standing down (mail 0029). A third state, needing its
   own pair of writes. The founding incident: the first real production mailbox did not sync for half
   an hour while its row said `connected`, `error_code = NULL`, `last_sync_at = NULL` — the worker knew
   the answer (`attach_lease_unavailable`, every 30 s) and wrote it only to stdout. Three branches
   behave this way, and none may reuse an existing write site: `markMailboxFailed` would be WRONG
   (`status='error'` puts the mailbox into the retry rotation and tells the user it is broken — "an
   infrastructure fault can never quarantine a mailbox"), and `markMailboxStoodDown` would be worse
   (`disabled` is STICKY, so a transient hiccup would permanently disconnect). So `status` IS NOT
   TOUCHED and neither are the four failure columns: these functions write exactly two columns and read
   none, safe on a mailbox in any state, and the four sites that own `status` each clear these two. */

import { type MailboxSyncBlockReason, isMailboxSyncBlockReason } from "@trafficflow/db";
export type { MailboxSyncBlockReason };
export { isMailboxSyncBlockReason };

/**
 * Record that this process is NOT SERVING a mailbox it knows is expected, and why. Returns false when
 * FENCED OUT — deliberately fenced even though it touches no lifecycle column, because the two columns
 * describe THIS process's relationship to the mailbox and a surrendered leader's late note is as stale
 * as its late failure write. Idempotent by `COALESCE`, which is why the caller may repeat it:
 * `reconcileRoster` calls this every pass while the block lasts, `sync_blocked_since` holds the start
 * of the CURRENT block, and the repeat is what converges the row when ANOTHER writer clears the columns
 * (a `PATCH /mailboxes/:id`) while the block is still in force. `.toISOString()` plus an EXPLICIT CAST,
 * copied from `markMailboxFailed`: inside a raw `sql` fragment postgres-js binds a bare `Date` as TEXT while PGlite accepts it, so the unit suite stays green while production throws (bitten twice).
 */
export async function markMailboxSyncBlocked(
  db: WorkerDb, mailboxId: string, reason: MailboxSyncBlockReason,
  opts: { fence?: LeaderFence; now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  // THE WRITE DOOR for a widenable set (mail 0029 opened it, mail 0102 widened it). The device
  // store carries no CHECK for it, so the membership test is the refusal on both dialects — and
  // the typed parameter is not one: this function is reachable from code the compiler never saw.
  const member = closedSetValue("mailboxes_sync_blocked_reason_closed", reason);
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes).set({
    syncBlockedReason: member,
    syncBlockedSince: sql`coalesce(${mailboxes.syncBlockedSince}, ${now.toISOString()}::timestamptz)`,
    // NOTHING ELSE. Not `status`, not `error_code`, not `error_detail`, not `failed_at`, not
    // `retry_count`. The absence is the design — see the block above this function.
  }).where(lifecycleWhere(mailboxId, opts.fence)).returning({ id: mailboxes.id }));
}

/**
 * A ceiling we set ended the cycle — the soft block, with its backoff, and nothing else.
 * `markMailboxFailed` was wrong here rather than imprecise: an `ImapBoundExceeded` means the mailbox
 * authenticated, answered, and sent more than one pass takes, and `status='error'` tells its owner it
 * failed. So this writes the mail-0029 pair (the honest "our own infrastructure is not serving this
 * right now") and leaves `status`, `error_code`, `error_detail`, `failed_at` and `retry_count` as they
 * were. Not `markMailboxSyncBlocked` with a third column: that function's three callers have no
 * next-attempt instant to record, this one does (mail 0039 makes it survive a restart). `retry_count`
 * is NOT incremented — it counts FAILURES and `markMailboxConnected` resets it; a cap hit is not one, and inflating it would lengthen the ladder for a mailbox whose only problem is its size.
 */
export async function markMailboxReadLimited(
  db: WorkerDb, mailboxId: string,
  opts: { fence?: LeaderFence; now?: Date; retryAfter?: Date | null } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes).set({
    syncBlockedReason: "read_limited",
    // `coalesce`, exactly as `markMailboxSyncBlocked` does it and for the same reason: the caller
    // repeats this while the block lasts, and the column holds the START of the block. The
    // `.toISOString()` cast is the idiom that module records as having bitten twice.
    syncBlockedSince: sql`coalesce(${mailboxes.syncBlockedSince}, ${now.toISOString()}::timestamptz)`,
    // `undefined` leaves the column alone; only an explicit `null` clears — `markMailboxFailed`'s
    // rule, so a caller cannot release a mailbox by omission.
    ...(opts.retryAfter !== undefined ? { retryAfter: opts.retryAfter } : {}),
  }).where(lifecycleWhere(mailboxId, opts.fence)).returning({ id: mailboxes.id }));
}

/**
 * The mailbox is being served again (or is no longer ours to serve): drop the note. Called by
 * `reconcileRoster` only when the row it just read ACTUALLY CARRIES a reason, so the steady state for
 * a healthy mailbox is zero writes per pass rather than one UPDATE per mailbox per 30 seconds. It
 * cannot be folded into `markMailboxConnected`: `attach` ends with `if (mb.status !== "connected")
 * await markRecovered(mb)`, and in this entire scenario `status` IS `connected` (a declined mailbox
 * was never marked failed), so `markRecovered` never runs and a clear living only inside it would
 * never fire.
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
 * Spend the one-shot takeover authorization, and record that this mailbox is ours again. Called after
 * a gate returns `organize`. `takeover_authorized_at` authorizes ONE becoming, not a standing right:
 * leaving it set would mean a lapse-then-resubscribe months later silently seizes the mailbox back
 * from whatever a human deliberately moved it to — the seize-back §4 forbids. `disabled_reason` is
 * cleared with it, so a mailbox a user re-enabled after a stand-down does not carry the old reason
 * while it is being organized again. A no-op UPDATE every cycle would be a write per mailbox per
 * minute for nothing, so the caller only invokes this when there is something to clear.
 */
export async function clearOrganizerStandDown(
  db: WorkerDb, mailboxId: string, opts: { fence?: LeaderFence; now?: Date } = {},
): Promise<boolean> {
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes)
    .set({
      // ── MAIL 0083: THIS IS THE PROMOTION ────────────────────────────────────────────────
      //
      // It used to clear two columns; it now performs the role flip that IS becoming the
      // organizer, and the four holder columns go with it. They must: a row that says
      // `organizer` while still naming who organizes it is a banner that contradicts itself, and
      // the banner reads the ROW rather than a live dial precisely so it can be read cheaply
      // everywhere.
      //
      // `disabledReason` is still cleared — for rows written before 0083, which carry one, and
      // for the mailbox a human re-enabled past an old stand-down. Nothing writes it any more.
      organizerRole: "organizer",
      organizedByKind: null,
      // Mail 0092 — this row names no holder now.
      organizedByInstallId: null,
      organizedByName: null,
      organizedSince: null,
      organizerState: null,
      // Mail 0089 — the fifth holder column goes with the other four; this row now names no
      // holder at all, and a stale capability set would answer a request-eligibility check about
      // an install that is no longer organizing this mailbox.
      organizedByCapabilities: null,
      disabledReason: null,
      // The authorization is spent by this one becoming. See the header.
      takeoverAuthorizedAt: null,
      /* And the OTHER one-shot: a promotion must not inherit a stop somebody asked of the role
         this row used to hold. Same rule as the demotion's — see `markMailboxStoodDown`. */
      releaseRequestedAt: null,
      // Mail 0088 — a mailbox organized here again is not a released one. The marker describes the
      // CURRENT state, so the promotion is what ends it; left standing it would make the next
      // claim-back report "you stopped organizing this" about a mailbox this install is organizing.
      organizerReleasedAt: null,
      // Mail 0088 — the second writer of the (role, state, holder) triple. A PROMOTION is an event
      // in exactly the sense the notice means: the person is entitled to be told once that this
      // install now organizes the mailbox, and on any other door they have open the sentence is
      // the one that says somebody else took it. Stamped in the same statement as the flip, on
      // `markMailboxStoodDown`'s reasoning.
      organizerEventAt: opts.now ?? new Date(),
    })
    .where(lifecycleWhere(mailboxId, opts.fence))
    .returning({ id: mailboxes.id }),
  // ── AND THE CONSEQUENCE THE ROLE FLIP HAS FOR WORK ALREADY OWED ────────────────────────
  //
  // Becoming the organizer widens what every owed "apply to existing mail" walk may look at, and
  // those walks carry a resume point that predates this mailbox. See
  // {@link clearOwedRetroFences} for what a stale one costs. In the SAME transaction, because a
  // role flipped without it is precisely the state that loses mail, and it must not be reachable
  // by a crash between two statements.
  (w) => clearOwedRetroFences(w, mailboxId));
}

/**
 * Refresh what a reader's last look saw — the four holder columns, from a `peekLease` read. A reader
 * stays on the roster and cycles, which is what makes these columns maintainable at all (see
 * `schema-mail.ts#organizerState`). One write per reader cycle, and only when something CHANGED: the
 * steady state of a reader whose organizer is quietly renewing is zero writes, like
 * `clearMailboxSyncBlock`'s. FENCED, like every write that describes this process's relationship to a
 * mailbox. It does NOT touch `organizerRole` — a peek is a look, never a decision, and the only two
 * writers of the role are the stand-down and the promotion above.
 */
export async function refreshOrganizerHolder(
  db: WorkerDb, mailboxId: string, by: StandDownHolder,
  opts: { fence?: LeaderFence; now?: Date; stateChanged?: boolean } = {},
): Promise<boolean> {
  return applyFenced(db, mailboxId, opts.fence, (w) => w.update(mailboxes)
    .set({
      organizedByKind: by.kind ?? null,
      // Mail 0092 — refreshed on the SAME peek as the kind, because the two must never disagree
      // about one claim: a stale id beside a fresh kind is exactly the confusion this closes.
      organizedByInstallId: by.installId ?? null,
      organizedByName: organizerDisplayName(by.displayName ?? null),
      organizedSince: by.claimedAt ?? null,
      organizerState: by.state ?? null,
      // Mail 0089 — the fifth holder column, refreshed on the SAME per-cycle peek as the other
      // four. Not part of the `stateChanged` occupancy-flip test below: a capability set changing
      // while occupancy does not (a holder's build upgrading mid-tenure) is not the notice's
      // business, the same argument `organizedSince` shifting under a renewed tenure already makes.
      organizedByCapabilities: capabilitiesColumn(by.capabilities),
      /* Mail 0088: the third writer, and the only one that stamps conditionally. It stamps
       * `organizer_event_at` ONLY WHEN `organizer_state` FLIPS, and the narrowness is the point. This
       * runs once per reader cycle and writes whenever ANY of the four columns moved — including
       * `organized_since` shifting because the holder renewed under a new tenure, or a display name
       * changing — and those are not events in the sense the notice means: nothing about who organizes
       * the mailbox changed, and a person would be told the same thing every time a peer restarted.
       * `held` → `stopped` and `stopped` → `held` ARE events (and either direction to or from NULL,
       * a holder appearing or vanishing). The caller decides, because the caller holds the previous
       * value — this function takes no read of its own, or that would be a second round trip per cycle. */
      ...(opts.stateChanged ? { organizerEventAt: opts.now ?? new Date() } : {}),
    })
    .where(lifecycleWhere(mailboxId, opts.fence))
    .returning({ id: mailboxes.id }));
}

/**
 * Record that these mailboxes completed a sync cycle. THE WRITER `last_sync_at` NEVER HAD. The column
 * was read in three places and written in none: `MailboxDTO.lastSyncAt` (the panel and Settings said
 * "not synced yet" forever, including for a demonstrably syncing mailbox), the admin console's "seconds
 * since last sync", and — the one that bites operations — `alerts.ts`'s sync-lag rule, which measures
 * `coalesce(last_sync_at, created_at)` against 15 minutes, so with the column permanently NULL every
 * healthy mailbox crosses the threshold 15 minutes after connecting and stays over it for life, firing
 * for everyone forever and being tuned out. This is `rt.lastSuccessAt` made durable. EVERY SUCCESSFUL
 * CYCLE, not every ingested message (a quiet mailbox is a success). ONE STATEMENT, batched across the rotation and best-effort; a single-id call inside the loop stamps a runtime's FIRST cycle eagerly.
 */
export async function stampMailboxSync(
  db: WorkerDb, mailboxIds: string[], now: Date,
): Promise<void> {
  if (mailboxIds.length === 0) return;
  await db.update(mailboxes).set({ lastSyncAt: now }).where(inArray(mailboxes.id, mailboxIds));
}

/**
 * {@link stampMailboxSync} at the DATABASE's own clock — `last_sync_at = now() - <elapsed>`. The
 * cycle's call sites use this rather than passing `new Date()`, because the pull affordance's honest
 * settle compares this column against `sync_requested_at` (stamped with SQL `now()`), and two columns
 * compared with each other must come off ONE clock — a worker-host `Date` put the worker's wall clock
 * into that comparison, where skew either settles a spinner before its scan or never settles it.
 * `backdateMs` makes the stamp claim the scan's START, never its finish: a stamp at COMPLETION claims
 * an instant later than the IMAP read it reports, so a pull landing in that gap is "settled" by a scan
 * that could not have seen its mail — so the caller passes how long ago its scan started and the write is `now() - elapsed`. The Date-taking form survives for callers that mean a SPECIFIC instant (alert tests).
 */
export async function stampMailboxSyncNow(
  db: WorkerDb, mailboxIds: string[], backdateMs = 0,
): Promise<void> {
  if (mailboxIds.length === 0) return;
  const behind = Math.max(0, Math.round(backdateMs));
  // GREATEST: this writer only ever RAISES the column. The pass-end batch backdates to the PASS's
  // start, and a woken visit inside that pass already stamped its own later visit-start instant, so an
  // unconditional write would overwrite the newer claim with the older, un-settling a pull the eager
  // stamp had just honestly settled. GREATEST ignores a NULL column, so a first stamp still lands. …AND
  // A FUTURE EXISTING VALUE IS REPLACED by this write's own candidate: a host-clock writer (an older
  // deployment, or the Date form) can plant a stamp in the DATABASE's future, and a bare GREATEST
  // would immortalize it; clamping to `now()` was still a lie (it claims a scan that COMPLETED this
  // instant), so the only truthful claim for a corrupted row is this write's own scan start. `behind`
  // is inlined via sql.raw, NOT bound — drizzle maps a bound parameter through PgTimestamp's
  // `.toISOString()` on a plain number — and is `Math.max(0, Math.round(...))`, a bare integer by construction.
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
 * Stamp `initial_import_completed_at` the FIRST time this mailbox's import has genuinely drained (mail
 * 0038) — the per-mailbox floor the client reads as `IS NULL ⇒ still importing`. Not `stampMailboxSync`:
 * `last_sync_at` is stamped after every successful cycle whether or not a backlog remains and is
 * batched across the rotation, both wrong here — this must land ONLY once a cycle completed with
 * `hasBacklog === false`, and it is a property of ONE mailbox, so a single-id write. `IS NULL` is what
 * makes it once-per-mailbox: the first no-backlog cycle sets the column and every later one matches
 * zero rows, with no read-then-write so two concurrent cycles cannot both stamp. Clearing it back to
 * NULL makes the client speak "still importing" again. BEST-EFFORT, like `stampMailboxSync`: the mailbox is serving, and a failed bookkeeping write must not tear that down.
 */
export async function stampInitialImportComplete(
  db: WorkerDb, mailboxId: string, now: Date,
): Promise<void> {
  await db.update(mailboxes)
    .set({ initialImportCompletedAt: now })
    .where(and(eq(mailboxes.id, mailboxId), isNull(mailboxes.initialImportCompletedAt)));
}
