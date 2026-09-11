/**
 * `attachment_staging` — the hosted send's direct-upload transport: the row, the object, and the
 * sweep that deletes them in one order. Reads are account-scoped HERE — `readStagingTickets` puts
 * the account id in the `WHERE` — so no caller can reach another account's rows; the one unscoped
 * read is the sweep's. The object half lives here because the worker runs the sweep and imports
 * core + db only. The sweep deletes the OBJECT first, then the row: the other order loses the
 * record of which object to remove. Two independent bounds: {@link
 * createStagingTicketWithinQuota} caps what one account may hold, {@link drainExpiredStaging}
 * deletes until empty; the quota counts only UNEXPIRED tickets.
 */
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { attachmentStaging } from "./schema-cloud.js";
import { assertLedgerTx, type LedgerTx, type Tx } from "./change-log.js";

/**
 * How long staged bytes live: 24 hours, and it is a PROMISE rather than a tuning knob — the
 * privacy copy states this number, so moving it changes what the product tells people about their
 * mail. Long enough that a send retried after a network outage still finds its bytes (the send
 * route re-reads the ticket on every attempt under the same idempotency key), short enough that
 * "transiently" is honest. The same 24 hours `idempotency_keys` promises, for the same reason:
 * one is the window a retry may happen in, and these are the bytes that retry needs.
 */
export const ATTACHMENT_STAGING_TTL_MS = 24 * 60 * 60 * 1000;

/** `expires_at` for a ticket minted now. */
export function attachmentStagingExpiry(now: Date): Date {
  return new Date(now.getTime() + ATTACHMENT_STAGING_TTL_MS);
}

/**
 * The ticket id is derived from the caller's idempotency key — the durable key IS the identity.
 * The mint creates a durable row and a signed grant to put bytes in a bucket; under a random id,
 * a retry after a lost response is a second row, a second object and a second helping of quota.
 * Deriving the id (rather than adding a keyed column) also fixes the object path: {@link
 * stagingObjectPath} is id-derived, so a retry's bytes land where the first attempt pointed. The
 * shape: 16 bytes of SHA-256 over `accountId \n key`, formatted as a uuid. The ACCOUNT is inside
 * the digest so one account's key can never name another's row; reads are account-scoped as well
 * — the scoping refuses, the digest makes a collision unconstructible.
 */
export function stagingTicketId(accountId: string, idempotencyKey: string): string {
  const h = createHash("sha256").update(`${accountId}\n${idempotencyKey}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5 — name-based, as this is
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface StagingTicketInput {
  /**
   * THE ID, MINTED BY THE CALLER. Not a database default, deliberately: the object path is derived
   * from the id, and a caller that had to wait for the insert to learn its id would have to write
   * the row twice — once with a placeholder path and once with the real one. Handing the id in
   * makes the row correct on its first and only write.
   */
  id: string;
  accountId: string;
  objectPath: string;
  filename: string;
  contentType: string;
  /** The DECLARED size, already refused against the cap by the caller. */
  sizeBytes: number;
  now: Date;
}

/** One staged ticket as every reader sees it. */
export interface StagingTicket {
  id: string;
  objectPath: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  expiresAt: Date;
}

/**
 * Mint a ticket. The row exists BEFORE the signed URL is handed out, and that order is the one
 * that cannot leak an object: an object whose row was never written is an object nothing knows the
 * path of, so {@link sweepExpiredStaging} can never find it and it lives in the bucket for the life
 * of the deployment. A row whose signed URL then failed to mint is the harmless direction — it
 * names an object that does not exist, the caller got an error, and the sweep deletes a row and a
 * storage 404, which {@link makeSupabaseStagingStorage}'s `remove` treats as success precisely so
 * that this case clears. The caller that performs the two steps in that order is the staging port
 * in `@trafficflow/services`; the reason is here because both halves it composes are here.
 */
export async function createStagingTicket(tx: Tx, i: StagingTicketInput): Promise<StagingTicket> {
  const [row] = await tx.insert(attachmentStaging).values({
    id: i.id,
    accountId: i.accountId,
    objectPath: i.objectPath,
    filename: i.filename,
    contentType: i.contentType,
    sizeBytes: i.sizeBytes,
    createdAt: i.now,
    expiresAt: attachmentStagingExpiry(i.now),
  }).returning({
    id: attachmentStaging.id,
    objectPath: attachmentStaging.objectPath,
    filename: attachmentStaging.filename,
    contentType: attachmentStaging.contentType,
    sizeBytes: attachmentStaging.sizeBytes,
    expiresAt: attachmentStaging.expiresAt,
  });
  if (!row) throw new Error("attachment staging ticket insert returned no row");
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PER-ACCOUNT QUOTA. See the module header for why there are two bounds.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How many staged tickets one account may hold at once — 500, five maximal composes
 * (`SEND_MAX_ATTACHMENT_PARTS` = 100 per message). "Two composes in flight" would be wrong here:
 * a send does NOT consume a ticket — no `consumed_at`, deliberately, because a retried send must
 * find the same bytes. A ticket's only exit is expiry, so the quota means "how much may be staged
 * in a 24-hour window". Ordinary use never approaches it: the staged transport does not engage
 * below 3 MB of attachments. What it buys: the per-account mint rate is now a number — 500 per
 * {@link ATTACHMENT_STAGING_TTL_MS}, ≈ 20.8 rows an hour — the input to {@link
 * STAGING_SWEEP_MAX_ROWS}.
 */
export const STAGING_MAX_OUTSTANDING_TICKETS = 500;

/**
 * How many declared bytes one account may hold at once — 1 GiB: roughly forty maximal 25 MB sends
 * in one retention window, far beyond honest use and still finite. It closes the one amplifier
 * the per-file cap cannot: that cap is the sending mailbox's own announced RFC 1870 `SIZE`,
 * somebody else's number (mail 0055 stores `bigint` for that reason) — a caller's own server may
 * announce 10 GB. Stated honestly: it counts DECLARED bytes — the signed grant binds content
 * type, not length, so a client may declare one byte and PUT more. The send path re-measures and
 * refuses; the bucket's own `file_size_limit` (storage configuration) bounds the bytes
 * themselves.
 */
export const STAGING_MAX_OUTSTANDING_BYTES = 1024 * 1024 * 1024;

/**
 * The `classid` half of the mint's `pg_advisory_xact_lock(int4, int4)` key; the second half is
 * `hashtext(account_id)`, so the lock is per account and mints for different accounts never queue
 * behind each other. It shares the `4207270…` prefix the worker's `LEADER_LOCK_KEY` uses, so the
 * project's advisory keys read as one family, and it fits `int4`. It cannot collide with either
 * single-argument key (the migration lock, the leader lock): Postgres keeps the one-argument
 * `bigint` form and the two-argument `(int4, int4)` form in separate keyspaces — distinguished by
 * `objsubid` in `pg_locks` — so equal numbers cannot alias.
 */
export const STAGING_QUOTA_LOCK_CLASS = 420_727_015;

/** What one account is allowed to hold staged at once. Injectable so tests can shrink it. */
export interface StagingQuota {
  maxTickets: number;
  maxBytes: number;
}

/** The product's quota. */
export const DEFAULT_STAGING_QUOTA: StagingQuota = {
  maxTickets: STAGING_MAX_OUTSTANDING_TICKETS,
  maxBytes: STAGING_MAX_OUTSTANDING_BYTES,
};

/** What an account is holding right now — UNEXPIRED tickets only. */
export interface StagingUsage {
  tickets: number;
  bytes: number;
}

/**
 * What a mint answered.
 *
 * A discriminated union rather than `ticket | null`, because the three outcomes need three
 * different sentences from the caller: a NEW ticket, the SAME ticket answered again (`replayed`,
 * which the caller may want to say or count but must not treat as a second grant), a quota
 * refusal carrying its numbers, and a key whose ticket has aged out. Mapping any of them to a
 * status is the service layer's job, not this module's.
 */
export type StagingMintOutcome =
  | { ok: true; ticket: StagingTicket; replayed: boolean }
  | { ok: false; reason: "quota"; refusal: StagingQuotaRefusal }
  | { ok: false; reason: "expired" };

/** Why a mint was refused, with the numbers a caller needs to say something actionable. */
export type StagingQuotaRefusal =
  | { limit: "tickets"; outstanding: number; cap: number }
  | { limit: "bytes"; outstanding: number; requested: number; cap: number };

/**
 * What `accountId` holds staged and UNEXPIRED as of `now`.
 *
 * Expired rows are excluded whether or not the sweep has reached them — see the module header for
 * why that decoupling is the whole point rather than an approximation.
 */
export async function outstandingStagingUsage(
  tx: Tx, accountId: string, now: Date,
): Promise<StagingUsage> {
  const [row] = await tx.select({
    // `count(*)` and `sum(bigint)` both come back from postgres-js as STRINGS. The `::int` cast
    // makes the count a number at the wire; the sum stays `bigint` (a declared size may exceed
    // 2^31 — that is why the column is bigint at all) and is narrowed here. Both totals are far
    // below 2^53 by construction: the quota that reads them is 1 GiB.
    tickets: sql<number>`count(*)::int`,
    bytes: sql<string>`coalesce(sum(${attachmentStaging.sizeBytes}), 0)::bigint`,
  }).from(attachmentStaging)
    .where(and(
      eq(attachmentStaging.accountId, accountId),
      gt(attachmentStaging.expiresAt, now),
    ));
  return { tickets: Number(row?.tickets ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/**
 * Mint a ticket if the account is under quota — check and insert in ONE transaction behind a
 * per-account advisory lock. A quota is an aggregate over rows the same statement adds to: under
 * READ COMMITTED, N simultaneous mints all read the same pre-state and all insert. There is no
 * row to lock, so the mutex is `pg_advisory_xact_lock(STAGING_QUOTA_LOCK_CLASS,
 * hashtext(account_id))`, taken before the aggregate is read; releasing at commit is wanted — the
 * signed-URL round trip happens strictly after it, and a lock across a network call is a
 * per-account stall. Deadlock-free by a single shared lock. Returns the refusal rather than
 * throwing — "too many uploads" and "too many bytes" need different copy.
 */
export async function createStagingTicketWithinQuota(
  tx: LedgerTx,
  i: StagingTicketInput,
  quota: StagingQuota = DEFAULT_STAGING_QUOTA,
): Promise<StagingMintOutcome> {
  // A lock taken on an autocommit handle is released at the end of its own statement and
  // serializes nothing, which would leave the quota exactly as racy as no lock at all — and it
  // would look correct in every single-threaded test.
  assertLedgerTx(tx, "createStagingTicketWithinQuota");

  await tx.execute(sql`
    select pg_advisory_xact_lock(
      ${STAGING_QUOTA_LOCK_CLASS}::int4,
      hashtext(${i.accountId}::text)::int4
    )
  `);

  // The replay branch, inside the lock and before the quota is read. `i.id` is {@link
  // stagingTicketId}'s digest of the caller's key, so a row under it is THIS request, already
  // served. Answering with it costs no quota (the same row, already counted), and the caller
  // re-signs a grant for its `object_path` — id-derived, so the retry's bytes land on the object
  // the first attempt was pointed at. The lock makes two simultaneous mints of one key serialize
  // here rather than race; the primary key would refuse the loser anyway, but the lock is what
  // gets the second caller an ANSWER rather than a constraint violation.
  const [existing] = await tx.select({
    id: attachmentStaging.id,
    objectPath: attachmentStaging.objectPath,
    filename: attachmentStaging.filename,
    contentType: attachmentStaging.contentType,
    sizeBytes: attachmentStaging.sizeBytes,
    expiresAt: attachmentStaging.expiresAt,
  }).from(attachmentStaging)
    .where(and(eq(attachmentStaging.id, i.id), eq(attachmentStaging.accountId, i.accountId)))
    .limit(1);
  if (existing) {
    // EXPIRED IS NOT REPLAYABLE, and it must not be minted over either.
    //
    // The row is still here only because the sweep has not reached it, and the sweep deletes the
    // OBJECT first — so re-signing would hand back a grant for bytes that are on their way out,
    // and overwriting the row in place would orphan the object it currently names (the one leak
    // this module's ordering exists to prevent). The refusal is temporary and self-healing: once
    // the sweep runs, the id is free and a fresh mint under the same key succeeds. It is also
    // twenty-four hours late by construction — the ticket's TTL and the send's idempotency window
    // are the same 24 hours — so nothing that could still be a retry can reach it.
    if (existing.expiresAt.getTime() <= i.now.getTime()) return { ok: false, reason: "expired" };
    return { ok: true, ticket: existing, replayed: true };
  }

  const usage = await outstandingStagingUsage(tx, i.accountId, i.now);
  if (usage.tickets >= quota.maxTickets) {
    return {
      ok: false, reason: "quota",
      refusal: { limit: "tickets", outstanding: usage.tickets, cap: quota.maxTickets },
    };
  }
  if (usage.bytes + i.sizeBytes > quota.maxBytes) {
    return {
      ok: false, reason: "quota",
      refusal: {
        limit: "bytes", outstanding: usage.bytes, requested: i.sizeBytes, cap: quota.maxBytes,
      },
    };
  }
  return { ok: true, ticket: await createStagingTicket(tx, i), replayed: false };
}

/**
 * The caller's OWN tickets, by id. Rows belonging to another account, and ids that name nothing,
 * are simply absent from the result — the caller compares lengths and refuses, which is one
 * answer for "not yours" and "not there" and therefore no existence oracle.
 *
 * EXPIRY IS NOT FILTERED HERE, deliberately. A row past `expires_at` whose object the sweep has
 * not reached yet is a ticket whose bytes may or may not still exist, and the send must be able to
 * tell "your upload expired" from "that was never yours". The send route compares `expiresAt`
 * against its own clock and says so; a filter here would collapse both into a 404.
 */
export async function readStagingTickets(
  tx: Tx, accountId: string, ids: readonly string[],
): Promise<StagingTicket[]> {
  if (ids.length === 0) return [];
  return tx.select({
    id: attachmentStaging.id,
    objectPath: attachmentStaging.objectPath,
    filename: attachmentStaging.filename,
    contentType: attachmentStaging.contentType,
    sizeBytes: attachmentStaging.sizeBytes,
    expiresAt: attachmentStaging.expiresAt,
  }).from(attachmentStaging)
    .where(and(
      eq(attachmentStaging.accountId, accountId),
      inArray(attachmentStaging.id, [...ids]),
    ));
}

/** One aged-out ticket as the sweep sees it. `expiresAt` is the drain's paging cursor. */
export interface ExpiredStagingTicket {
  id: string;
  objectPath: string;
  expiresAt: Date;
}

/**
 * Everything aged out, oldest first, bounded. The bound is a PAGE size, not a retention budget —
 * {@link drainExpiredStaging} keeps calling until nothing is left; the sweep runs in the worker's
 * serial maintenance slot, so an unbounded statement would hold that slot against a mailbox that
 * wants to sync. The order is total: `expires_at` ties are common (a compose window mints a dozen
 * tickets in one millisecond), so `id` breaks the tie and the cursor is the pair. The cursor
 * exists for one case: a page whose object delete fails permanently keeps its rows — the OLDEST
 * rows — and a drain restarting from the beginning would re-attempt the poisoned page forever.
 * Advancing past every attempted page turns one unremovable object into a bounded per-hour retry.
 */
export async function expiredStagingTickets(
  tx: Tx, now: Date, limit: number,
  after: { expiresAt: Date; id: string } | null = null,
): Promise<ExpiredStagingTicket[]> {
  const aged = lte(attachmentStaging.expiresAt, now);
  return tx.select({
    id: attachmentStaging.id,
    objectPath: attachmentStaging.objectPath,
    expiresAt: attachmentStaging.expiresAt,
  }).from(attachmentStaging)
    .where(after
      // ISO strings with explicit casts rather than Date objects: postgres-js has serialized a
      // Date as TEXT inside a template before (`migrate.ts` records the family), and a row
      // comparison is the one place that would silently compare the wrong things.
      ? and(aged, sql`(${attachmentStaging.expiresAt}, ${attachmentStaging.id}) > (${after.expiresAt.toISOString()}::timestamptz, ${after.id}::uuid)`)
      : aged)
    .orderBy(attachmentStaging.expiresAt, attachmentStaging.id)
    .limit(limit);
}

/** Delete tickets by id. Returns how many rows went. */
export async function deleteStagingTickets(tx: Tx, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const gone = await tx.delete(attachmentStaging)
    .where(inArray(attachmentStaging.id, [...ids]))
    .returning({ id: attachmentStaging.id });
  return gone.length;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE OBJECT HALF. See the module header for why it is here rather than beside the send path.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Where the bucket lives and what may talk to it. */
export interface AttachmentStagingStorageConfig {
  /** `https://<ref>.supabase.co` — no trailing slash, no `/storage/v1`. */
  url: string;
  /**
   * The SERVICE-ROLE key. It is the only credential that reaches this bucket: the bucket is
   * private, has no public read, and no anon-key policy grants anything on it. The browser never
   * sees this — it receives a signed URL minted with it, scoped to one object and one upload.
   */
  serviceKey: string;
  /** The dedicated staging bucket. Never a bucket anything else writes to. */
  bucket: string;
}

/** Failure of a storage call, carrying the status so a caller can tell "misconfigured" from "gone". */
export class AttachmentStagingStorageError extends Error {
  constructor(readonly operation: string, readonly status: number, message: string) {
    super(`attachment staging ${operation} failed (${status}): ${message}`);
    this.name = "AttachmentStagingStorageError";
  }
}

/**
 * A staged object that is bigger than the ticket said it would be, refused DURING the read.
 *
 * `declaredBytes` is the object's own `Content-Length` when the response carried one — the read
 * was then refused before it started, and the number is exact. When it is `null` the response
 * declared no length (or a false one) and the transfer was abandoned mid-stream, so all that is
 * known is that the object is over `maxBytes`.
 */
export class StagedObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number, readonly declaredBytes: number | null) {
    super(`staged object exceeds ${maxBytes} bytes`);
    this.name = "StagedObjectTooLargeError";
  }
}

/**
 * Read a fetch Response body under a byte ceiling, counting as it arrives.
 *
 * The same shape as the API door's `readBodyWithin`, and for the same reason: a check after
 * `res.arrayBuffer()` is a check on bytes that are already the cost being refused. The declared
 * length is consulted first — that refuses an honest oversized object for nothing — and the
 * stream is then counted before each chunk is retained, so the peak is one chunk over the ceiling.
 */
async function readObjectWithin(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => { /* already gone */ });
    throw new StagedObjectTooLargeError(maxBytes, declared);
  }
  const body = res.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new StagedObjectTooLargeError(maxBytes, null);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => { /* already closed, or already errored */ });
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** The three storage calls, as an injectable port so tests can drive the whole path with no network. */
export interface AttachmentStagingStorage {
  /** Mint a signed, single-object upload grant. */
  signUpload(objectPath: string, contentType: string): Promise<{
    uploadUrl: string; uploadMethod: string; uploadHeaders: Record<string, string>;
  }>;
  /**
   * Read an object's bytes with the service credential. `opts.maxBytes` is a ceiling on the READ,
   * not its result: the declared `Content-Length` is refused before a byte is pulled, and a
   * response that declares nothing (or lies) is counted as it streams and abandoned the moment it
   * crosses — over it, this rejects with {@link StagedObjectTooLargeError}. It exists because the
   * ceiling used to be applied AFTERWARDS: `resolveStagedAttachments` compared `bytes.byteLength`
   * on bytes already in the heap, and the presigned PUT signs only the content TYPE, so a
   * one-byte ticket could stage an object of any size and this process buffered it whole.
   * Optional so every fake storage in a test keeps compiling; every production caller passes it.
   */
  download(objectPath: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
  /** Remove objects. Best-effort by contract: a path that is already gone is not an error. */
  remove(objectPaths: readonly string[]): Promise<void>;
}

const STORAGE_PREFIX = "/storage/v1";

/**
 * The Supabase Storage implementation. `signUpload` returns the token-bearing URL and the exact
 * headers the browser must present: the endpoint authenticates by the `token` query parameter, so
 * no credential of ours travels to the browser — and `x-upsert: false` makes a second upload to
 * the same path a refusal rather than a silent replacement of bytes a send may already have read.
 * The wire is plain `fetch`: four HTTP calls do not justify a client library, and
 * `supabase-lockdown.ts` already reaches the same project the same way. VERIFY THIS ROUND TRIP ON
 * THE FIRST DEPLOY: one wrong shape is a mint that answers 200 with a URL that refuses the
 * upload; the sweep and the send degrade safely, the mint fails one step later, at upload time.
 */
export function makeSupabaseStagingStorage(
  cfg: AttachmentStagingStorageConfig,
  fetchImpl: typeof fetch = fetch,
): AttachmentStagingStorage {
  const base = `${cfg.url.replace(/\/+$/, "")}${STORAGE_PREFIX}`;
  const auth = {
    authorization: `Bearer ${cfg.serviceKey}`,
    apikey: cfg.serviceKey,
  };
  const enc = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

  return {
    async signUpload(objectPath, contentType) {
      const res = await fetchImpl(
        `${base}/object/upload/sign/${encodeURIComponent(cfg.bucket)}/${enc(objectPath)}`,
        { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" },
      );
      if (!res.ok) {
        throw new AttachmentStagingStorageError("sign", res.status, await res.text().catch(() => ""));
      }
      const body = (await res.json()) as { url?: unknown };
      const rel = typeof body.url === "string" ? body.url : "";
      if (!rel) throw new AttachmentStagingStorageError("sign", res.status, "no signed url in response");
      return {
        // The response's `url` is relative to the storage root and already carries `?token=`.
        uploadUrl: rel.startsWith("http") ? rel : `${base}${rel.startsWith("/") ? "" : "/"}${rel}`,
        uploadMethod: "PUT",
        uploadHeaders: { "content-type": contentType, "x-upsert": "false" },
      };
    },

    async download(objectPath, opts) {
      const res = await fetchImpl(
        `${base}/object/${encodeURIComponent(cfg.bucket)}/${enc(objectPath)}`,
        { method: "GET", headers: auth },
      );
      if (!res.ok) {
        throw new AttachmentStagingStorageError("download", res.status, await res.text().catch(() => ""));
      }
      return opts?.maxBytes === undefined
        ? new Uint8Array(await res.arrayBuffer())
        : await readObjectWithin(res as unknown as Response, opts.maxBytes);
    },

    async remove(objectPaths) {
      if (objectPaths.length === 0) return;
      const res = await fetchImpl(`${base}/object/${encodeURIComponent(cfg.bucket)}`, {
        method: "DELETE",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: [...objectPaths] }),
      });
      // 404 is SUCCESS here: the sweep's job is "these bytes are gone", and bytes that were never
      // written satisfy it. Anything else is a real failure and keeps the row for the next pass.
      if (!res.ok && res.status !== 404) {
        throw new AttachmentStagingStorageError("remove", res.status, await res.text().catch(() => ""));
      }
    },
  };
}

/** Where an S3-compatible staging bucket lives and what may talk to it. Parsed from the frozen
 *  `S3_*` variable set by the self-host server's config loader; the names here match those. */
export interface S3StagingStorageConfig {
  /** `https://s3.<region>.amazonaws.com`, or the operator's own endpoint (`http://minio:9000`,
   *  a reverse-proxied path). Scheme, host, port and any base path are all honoured. */
  endpoint: string;
  /** The SigV4 signing region. MinIO accepts whatever it was started with (`us-east-1` default). */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The dedicated staging bucket. Never a bucket anything else writes to. */
  bucket: string;
  /**
   * The endpoint a BROWSER can reach — `S3_PUBLIC_ENDPOINT` on the self-host server, defaulted to
   * `OHMAIL_ORIGIN`; absent ⇒ {@link endpoint}. `download` and `remove` reach the store by its
   * in-network name (`http://minio:9000`); the presigned PUT runs in a browser that cannot
   * resolve that name and whose CSP refuses off-origin requests. SigV4 covers the `Host` header,
   * so the grant is signed against the browser-facing origin and the reverse proxy must carry the
   * PUT with the Host PRESERVED. SECURITY INVARIANT: routing `/<bucket>/*` through the public
   * origin is safe ONLY while the bucket stays private — an unsigned request must 403; no
   * anonymous bucket policy, ever.
   */
  publicEndpoint?: string;
}

/**
 * How long a presigned PUT grant is honoured, in seconds — 1 hour.
 *
 * Deliberately much shorter than {@link ATTACHMENT_STAGING_TTL_MS}: the TTL is a promise about
 * the BYTES ("staged transiently, held 24 hours"), while this is the window in which the grant's
 * holder may still write them. A compose uploads the moment the grant is minted, so an hour is
 * generous for a slow link and small enough that a leaked grant URL goes stale the same
 * afternoon. It also bounds the overwrite window stated on {@link makeS3StagingStorage}.
 */
export const S3_UPLOAD_GRANT_TTL_SECONDS = 3600;

/**
 * The object URL for one staged file — and the addressing decision that can silently break: SigV4
 * signs the `Host` header, so path-style vs virtual-host is baked into every signature, and the
 * wrong choice is a blanket 403. The rule is ENDPOINT-DRIVEN (the frozen `S3_*` set has no style
 * flag): a real AWS endpoint takes virtual-host style — the only style AWS still promises for new
 * buckets; everything else takes path-style, the only style that works when TLS does not cover
 * `<bucket>.<host>`; a DOTTED bucket falls back to path-style even on AWS, whose wildcard does
 * not cover it. Key segments are percent-encoded — keys here are ids by construction, but a URL
 * builder must not trust that.
 */
export function s3StagingObjectUrl(
  cfg: Pick<S3StagingStorageConfig, "endpoint" | "bucket">, objectPath: string,
): string {
  const u = new URL(cfg.endpoint);
  const basePath = u.pathname.replace(/\/+$/, "");
  const key = objectPath.split("/").map(encodeURIComponent).join("/");
  const awsHosted = /(^|\.)amazonaws\.com$/.test(u.hostname.toLowerCase());
  const dnsSafeBucket = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(cfg.bucket);
  if (awsHosted && dnsSafeBucket && basePath === "") {
    return `${u.protocol}//${cfg.bucket}.${u.host}/${key}`;
  }
  return `${u.protocol}//${u.host}${basePath}/${encodeURIComponent(cfg.bucket)}/${key}`;
}

/**
 * The S3-compatible implementation of the same three-method port — MinIO, or any S3 endpoint.
 * SigV4 via `aws4fetch`; three HTTP shapes do not justify an SDK. The grant is minted LOCALLY: a
 * presigned PUT is pure key derivation, so misconfiguration surfaces at UPLOAD time as the
 * client's 403 (harmless: a row whose object never arrives is swept as a 404); the live MinIO
 * suite and the compose boot-smoke verify the round trip. The grant binds the content type; there
 * is no `x-upsert` equivalent — a plain S3 PUT overwrites, and the exposure is one account
 * re-PUTting its OWN ticket's path, which the send re-measures. Deletes are per-object, and 404
 * counts as success: a half-failed page keeps its rows and next hour re-deletes.
 */
export function makeS3StagingStorage(
  cfg: S3StagingStorageConfig,
  fetchImpl: typeof fetch = fetch,
): AttachmentStagingStorage {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: cfg.region,
    // Retries belong to callers (the sweep retries by keeping rows; the send by failing the
    // request) — a transport that retried on its own would hold locksteps nobody asked for.
    retries: 0,
  });
  const urlFor = (objectPath: string): string => s3StagingObjectUrl(cfg, objectPath);
  // The upload grant alone is addressed at the BROWSER-facing endpoint (see the config field's
  // header): the URL is built against it BEFORE signing, so the SigV4 `Host` in the signature is
  // the host the browser will actually present through the proxy.
  const uploadUrlFor = (objectPath: string): string =>
    s3StagingObjectUrl({ endpoint: cfg.publicEndpoint ?? cfg.endpoint, bucket: cfg.bucket }, objectPath);
  const DELETE_BATCH = 16;

  return {
    async signUpload(objectPath, contentType) {
      const url = new URL(uploadUrlFor(objectPath));
      url.searchParams.set("X-Amz-Expires", String(S3_UPLOAD_GRANT_TTL_SECONDS));
      // `allHeaders: true` is what signs `content-type` (aws4fetch skips it by default), which
      // is what makes the grant refuse a PUT that lies about its type.
      const signed = await client.sign(url.toString(), {
        method: "PUT",
        headers: { "content-type": contentType },
        aws: { signQuery: true, allHeaders: true },
      });
      return {
        uploadUrl: signed.url,
        uploadMethod: "PUT",
        uploadHeaders: { "content-type": contentType },
      };
    },

    async download(objectPath, opts) {
      const req = await client.sign(urlFor(objectPath), { method: "GET" });
      const res = await fetchImpl(req);
      if (!res.ok) {
        throw new AttachmentStagingStorageError("download", res.status, await res.text().catch(() => ""));
      }
      return opts?.maxBytes === undefined
        ? new Uint8Array(await res.arrayBuffer())
        : await readObjectWithin(res as unknown as Response, opts.maxBytes);
    },

    async remove(objectPaths) {
      for (let i = 0; i < objectPaths.length; i += DELETE_BATCH) {
        await Promise.all(objectPaths.slice(i, i + DELETE_BATCH).map(async (p) => {
          const req = await client.sign(urlFor(p), { method: "DELETE" });
          const res = await fetchImpl(req);
          // 204 is S3's answer for present AND absent keys; 404 is some compatibles' answer for
          // absent ones. Both mean what the sweep needs: these bytes are gone.
          if (!res.ok && res.status !== 404) {
            throw new AttachmentStagingStorageError("remove", res.status, await res.text().catch(() => ""));
          }
          // Drain so keep-alive sockets are reusable across a 200-path page.
          await res.arrayBuffer().catch(() => {});
        }));
      }
    },
  };
}

/**
 * The object path for one staged file: `<accountId>/<ticketId>`.
 *
 * ACCOUNT-PREFIXED and otherwise ONLY IDS. The filename never enters the path — a user-supplied
 * name in an object key is a traversal and a header-injection surface for no benefit, since the
 * name the recipient sees comes off the row. The account prefix is what makes a bucket listing
 * legible to an operator and what a future per-account storage policy would key on.
 */
export function stagingObjectPath(accountId: string, ticketId: string): string {
  return `${accountId}/${ticketId}`;
}

/** How many expired tickets ONE PAGE takes. See `expiredStagingTickets` for why a page is bounded. */
export const STAGING_SWEEP_BATCH = 200;

/**
 * How many expired rows one drain may touch — 50 000, 250 pages of {@link STAGING_SWEEP_BATCH}. A
 * ticket's only exit is expiry, so a saturated account produces expired rows at exactly {@link
 * STAGING_MAX_OUTSTANDING_TICKETS} per {@link ATTACHMENT_STAGING_TTL_MS} ≈ 20.8 rows/hour, no
 * more. The drain runs hourly, so 50 000 keeps up with ≈ 2 400 continuously saturated accounts.
 * The old single 200-row page an hour was outrun by one account minting 201 times an hour —
 * permanently, and in front of every other account's rows, since the predicate is the clock. A
 * ceiling, not a target: the drain stops when the expired set is empty; when it binds,
 * `stoppedBy: "rows"` is logged — the failure here is a backlog growing in silence.
 */
export const STAGING_SWEEP_MAX_ROWS = 50_000;

/**
 * The wall-clock budget for one drain — 60 s. The row ceiling bounds WORK; this bounds TIME. The
 * drain runs in the worker's serial maintenance slot, and the thing that must never happen is a
 * cycle held open behind object storage having a bad afternoon: 250 pages at two seconds each is
 * eight minutes of a slot a mailbox is waiting for. A drain cut short is not a lost pass: the
 * rows it did not reach are still expired, the next hour starts from the oldest, and `stoppedBy:
 * "deadline"` is logged so a deployment that keeps hitting it is visible rather than merely slow.
 */
export const STAGING_SWEEP_DEADLINE_MS = 60_000;

/** What one drain did. `drained` is the only field that promises the table is clear. */
export interface StagingDrainResult {
  /** Rows whose object and row both went. */
  deleted: number;
  /** Pages attempted, successful or not. */
  pages: number;
  /**
   * Pages whose object delete failed. Their rows are untouched and the next drain retries them —
   * a non-zero count means the bucket is refusing deletes, which is an operator's business.
   */
  failedPages: number;
  /** TRUE only when the expired set was emptied AND no page failed. Never inferred from `deleted`. */
  drained: boolean;
  /** Which bound ended the loop. `"dry"` is the ordinary answer. */
  stoppedBy: "dry" | "rows" | "deadline";
}

/**
 * One maintenance pass over expired staging tickets: object first, then row. Dependencies are
 * injected because the trap lives here — an abandoned upload leaves a row and no object, and a
 * sweep written against the happy path would treat the storage 404 as a failure and keep the row
 * forever; `remove` treats 404 as success, and the row goes (the case the pg test exists for). A
 * storage failure throws — the next pass retries; swallowing it would report a clean number while
 * the bucket grew. THIS IS ONE PAGE and nothing calls it alone any more: {@link
 * drainExpiredStaging} is the loop, and the worker calls that. The page stays a separate function
 * because the ORDER it implements is the invariant, worth stating and testing on its own.
 */
export async function sweepExpiredStaging(deps: {
  storage: AttachmentStagingStorage;
  expired: (limit: number) => Promise<Array<{ id: string; objectPath: string }>>;
  deleteRows: (ids: readonly string[]) => Promise<number>;
  limit?: number;
}): Promise<number> {
  const rows = await deps.expired(deps.limit ?? STAGING_SWEEP_BATCH);
  if (rows.length === 0) return 0;
  // OBJECTS FIRST. A row deleted before its object is an object nobody can name again.
  await deps.storage.remove(rows.map((r) => r.objectPath));
  return deps.deleteRows(rows.map((r) => r.id));
}

/**
 * Drain the expired set — pages of {@link sweepExpiredStaging} until empty or a bound stops it
 * ({@link STAGING_SWEEP_MAX_ROWS} work, {@link STAGING_SWEEP_DEADLINE_MS} time); the old single
 * page an hour grew the backlog forever. A failed page is SKIPPED, not re-attempted in place:
 * failed rows are the oldest, so restarting from the top would hand the same poisoned page to
 * storage forever. The cursor advances past every attempted page; a failing page keeps its rows,
 * counts in `failedPages`, and is retried next hour. No row appears behind the cursor: `now` is
 * fixed and `expires_at` only moves forward. The page stays composed, not inlined: the order —
 * object, then row — has exactly one implementation.
 */
export async function drainExpiredStaging(deps: {
  storage: AttachmentStagingStorage;
  expired: (
    limit: number, after: { expiresAt: Date; id: string } | null,
  ) => Promise<ExpiredStagingTicket[]>;
  deleteRows: (ids: readonly string[]) => Promise<number>;
  pageSize?: number;
  maxRows?: number;
  deadlineMs?: number;
  /** Injected so a test can drive the deadline without waiting for it. */
  clock?: () => number;
  /** Called once per failed page. The worker logs; nothing here decides what a failure means. */
  onPageError?: (err: unknown, rows: readonly ExpiredStagingTicket[]) => void;
}): Promise<StagingDrainResult> {
  const pageSize = deps.pageSize ?? STAGING_SWEEP_BATCH;
  const maxRows = deps.maxRows ?? STAGING_SWEEP_MAX_ROWS;
  const deadlineMs = deps.deadlineMs ?? STAGING_SWEEP_DEADLINE_MS;
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();

  let after: { expiresAt: Date; id: string } | null = null;
  let scanned = 0;
  let deleted = 0;
  let pages = 0;
  let failedPages = 0;
  let stoppedBy: StagingDrainResult["stoppedBy"] = "dry";

  for (;;) {
    if (scanned >= maxRows) { stoppedBy = "rows"; break; }
    if (clock() - startedAt >= deadlineMs) { stoppedBy = "deadline"; break; }

    const limit = Math.min(pageSize, maxRows - scanned);
    const rows = await deps.expired(limit, after);
    if (rows.length === 0) { stoppedBy = "dry"; break; }

    // SCANNED, NOT DELETED, is what the ceiling counts. A drain whose pages all fail must still
    // terminate, and a budget spent on rows that did not go is a budget spent.
    scanned += rows.length;
    pages += 1;
    const last = rows[rows.length - 1]!;
    after = { expiresAt: last.expiresAt, id: last.id };

    try {
      deleted += await sweepExpiredStaging({
        storage: deps.storage,
        expired: async () => rows,
        deleteRows: deps.deleteRows,
        limit: rows.length,
      });
    } catch (err) {
      failedPages += 1;
      deps.onPageError?.(err, rows);
    }
  }

  // `drained` is asserted, never inferred. "The loop ran out of rows" and "the table is clear" are
  // different claims whenever a page failed, and reporting the second one from the first is how a
  // growing bucket reads as a clean sweep.
  return { deleted, pages, failedPages, drained: stoppedBy === "dry" && failedPages === 0, stoppedBy };
}

/**
 * The drain bound to a database handle — what the worker's hourly maintenance slot calls. A thin
 * composition over {@link drainExpiredStaging} and the statements above, here rather than in the
 * worker so the order (object, then row) and the paging cursor have exactly one implementation.
 * This is the single symbol the worker needs out of the whole transport, and having it on
 * `@trafficflow/db/cloud` keeps the worker's runtime closure to the five packages its dependency
 * test names. `now` is captured once and used for every page, so the drain's own runtime cannot
 * pull rows into its horizon mid-loop.
 */
export async function sweepExpiredStagingFor(
  db: Tx, storage: AttachmentStagingStorage, now: Date,
  opts: {
    pageSize?: number; maxRows?: number; deadlineMs?: number; clock?: () => number;
    onPageError?: (err: unknown, rows: readonly ExpiredStagingTicket[]) => void;
  } = {},
): Promise<StagingDrainResult> {
  return drainExpiredStaging({
    storage,
    expired: (n, after) => expiredStagingTickets(db, now, n, after),
    deleteRows: (ids) => deleteStagingTickets(db, ids),
    ...opts,
  });
}
