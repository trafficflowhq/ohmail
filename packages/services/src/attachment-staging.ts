/**
 * ATTACHMENT STAGING — the hosted send's direct-upload transport, SEND-FACING half.
 *
 * ## What this replaces, and what it does not
 *
 * Attachment bytes used to ride the send request body base64-encoded. That put every hosted send
 * under the serverless platform's ~4.5 MB request limit and forced the compose surface to promise
 * 3 MB whatever the sender's own submission server announced — so a mailbox that accepts 25 MB was
 * told 3, in the one place a user reads a promise. The bytes now go straight from the browser to
 * object storage on a signed URL, and the send carries a REFERENCE to a
 * `attachment_staging` row.
 *
 * **The inline path is not removed.** It is the transport a 0.9.3-vintage desktop uses — its Cloud
 * door forwards `POST /drafts/:id/send` verbatim to this API — so the send route accepts both
 * shapes and this module exists beside the old path rather than in place of it.
 *
 * ## Where the other half is, and why
 *
 * The TABLE, the BUCKET and the retention SWEEP are in `@trafficflow/db/cloud`
 * (`packages/db/src/attachment-staging.ts`), not here. The sweep's only caller is the worker's
 * hourly maintenance slot, and the worker's runtime closure is `core` + `db` and nothing else
 * (enforced by the worker's dependency test) — a sweep above that line is a sweep the
 * process that runs it has to reach up for. It did, briefly, and the cost was measured: with this
 * package's barrel in the worker's boot graph, `node` loads an HTML sanitiser and its parser on
 * the way to a retention sweep, and on Node 23 that pair is a hard `ERR_REQUIRE_CYCLE_MODULE` at
 * import time. The pinned Node 22 image was the only thing standing between a deployed worker and
 * an unloggable crash-on-start.
 *
 * What is left here is what is genuinely service-shaped: turning a ticket into a `SendAttachment`,
 * and mapping every way that can fail onto the status the caller gets back. Both name types the
 * worker has no use for.
 *
 * ## The order of operations, and why it is that order
 *
 * MINT checks the account's outstanding quota and writes the row in ONE transaction, and THEN asks
 * storage for a signed URL. The other order leaks: an object whose row was never written is an
 * object nothing knows the path of, so the sweep cannot find it and it lives in the bucket for the
 * life of the deployment. A row whose signed URL then failed to mint is the harmless direction —
 * it names an object that does not exist, the caller got an error, and the sweep deletes a row and
 * a 404 in 24 hours.
 *
 * The quota itself — the numbers, and the per-account lock that makes the check exact rather than
 * racy — is `createStagingTicketWithinQuota` in `@trafficflow/db/cloud`, beside the table. What is
 * here is the half that is genuinely service-shaped: turning its refusal into the status and the
 * sentence a person reads (see {@link stagingQuotaError}).
 *
 * SEND reads the ticket, checks the declared total, downloads, and re-measures. The declared size
 * is a CLIENT ASSERTION and is treated as one: it bounds what we are willing to fetch, and the
 * bytes that arrive are what the cap is finally enforced against.
 *
 * SWEEP deletes the object and then the row, which is the only order that cannot orphan bytes —
 * see `sweepExpiredStaging` in `@trafficflow/db/cloud` for the whole of that argument.
 */
import { randomUUID } from "node:crypto";
import {
  createStagingTicketWithinQuota, readStagingTickets, stagingObjectPath, stagingTicketId,
  DEFAULT_STAGING_QUOTA,
  StagedObjectTooLargeError,
  type AttachmentStagingStorage, type StagingQuota, type StagingQuotaRefusal,
} from "@trafficflow/db/cloud";
import type { LedgerTx, Tx } from "@trafficflow/db";
import { ServiceError } from "./errors.js";
import type { SendAttachment } from "./send-service.js";

/** What a mint hands back to the caller: the ticket, and how to put bytes at it. */
export interface StagedUploadGrant {
  /** The `attachment_staging` row id — what the send request references. */
  id: string;
  /** The absolute URL the client uploads to. Opaque to the client. */
  uploadUrl: string;
  /** The method the client must use. Opaque to the client; today always `PUT`. */
  uploadMethod: string;
  /**
   * Headers the client must send with the upload, verbatim.
   *
   * OPAQUE ON PURPOSE. Storage wire details — how the token is presented, whether an upsert is
   * permitted — are the storage client's business, and a client that reconstructed them would be a
   * second implementation of a contract only one side can see. The client's whole job is
   * `fetch(uploadUrl, { method, headers, body })`.
   */
  uploadHeaders: Record<string, string>;
  /** When the staged bytes stop existing. Stated so the surface can say it. */
  expiresAt: string;
}

/** A ticket as the send path needs it, plus the bytes it resolved to. */
export interface ResolvedStagedAttachment extends SendAttachment {
  ticketId: string;
}

/** Why a staged reference could not be turned into bytes. */
export type StagedResolutionFailure =
  /** No such ticket for this account — a foreign id and a nonexistent one answer identically. */
  | { reason: "unknown"; id: string }
  /** The ticket is past its retention window. Distinct from `unknown` so the user is told which. */
  | { reason: "expired"; id: string }
  /** The object is missing or storage refused. */
  | { reason: "unavailable"; id: string }
  /** The bytes that arrive are larger than the ticket declared. */
  | {
    reason: "size_mismatch"; id: string; declared: number;
    /** Exact, unless {@link abandoned} — then it is a LOWER BOUND (the ceiling, plus one). */
    actual: number;
    /** The read was cut off at the ceiling, so `actual` is a floor rather than the size. */
    abandoned?: true;
  };

/**
 * Turn staged references into bytes, or say exactly why not.
 *
 * The DECLARED total is checked by the caller before this runs — this function is the download,
 * and it re-measures every object against the size its ticket declared. A client that declares
 * 1 MB and uploads 50 is refused HERE, before the bytes reach the send's own cap check, because
 * the alternative is that the cap is enforced against a number the attacker chose.
 *
 * ── ONE TICKET, ONE DOWNLOAD — AND THE INVARIANT LIVES HERE, NOT ONLY AT THE BOUNDARY ───────
 *
 * `requestedIds` is a CLIENT-SUPPLIED array and may name the same ticket any number of times.
 * This loop walks the DISTINCT ids, so `storage.download` runs once per object however often it
 * was named, and the result carries each file once.
 *
 * The route deduplicates too, and this is deliberately not redundant with it: the amplification is
 * a property of `await download()` sitting inside a loop over a request array, so the fix belongs
 * where that loop is. This function is an exported service-level entry point with callers that do
 * not pass through that route, and "every future caller remembers to dedupe first" is exactly the
 * kind of rule this file's own header refuses to rely on elsewhere.
 *
 * Order is first appearance, which is the order the composer listed the files in.
 */
export async function resolveStagedAttachments(
  storage: AttachmentStagingStorage,
  tickets: ReadonlyArray<{
    id: string; objectPath: string; filename: string; contentType: string;
    sizeBytes: number; expiresAt: Date;
  }>,
  requestedIds: readonly string[],
  now: Date,
): Promise<
  | { ok: true; attachments: ResolvedStagedAttachment[] }
  | { ok: false; failure: StagedResolutionFailure }
> {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const out: ResolvedStagedAttachment[] = [];
  for (const id of new Set(requestedIds)) {
    const t = byId.get(id);
    if (!t) return { ok: false, failure: { reason: "unknown", id } };
    if (t.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, failure: { reason: "expired", id } };
    }
    let bytes: Uint8Array;
    try {
      /**
       * ── THE TICKET'S DECLARED SIZE IS A CEILING ON THE READ, not a check afterwards ───────
       *
       * This was `storage.download(t.objectPath)` followed by the byteLength comparison below,
       * which is a correct comparison made on bytes that are already the cost. And the gap it
       * left is reachable: the presigned PUT signs only the content TYPE, so an authenticated
       * caller can mint a ONE-BYTE ticket, upload an object of any size to the path it names,
       * and then send that ticket — this process buffered the whole object and noticed the
       * mismatch after paying for it. Authenticated remote memory exhaustion, repeatable.
       *
       * The ceiling is the ticket's own `sizeBytes`, which is the number the comparison below
       * already uses; the port refuses the declared `Content-Length` before reading and abandons
       * the stream at the ceiling when the response declares nothing or lies.
       *
       * The comparison below is KEPT rather than replaced. It is now unreachable through this
       * port — but `AttachmentStagingStorage` is injectable, and a storage that ignores
       * `maxBytes` (a fake, an older implementation) must still be refused rather than trusted.
       */
      bytes = await storage.download(t.objectPath, { maxBytes: t.sizeBytes });
    } catch (err) {
      const tooLarge = err instanceof StagedObjectTooLargeError ? err : null;
      if (tooLarge) {
        // `actual` is exact when the object declared its length and a LOWER BOUND when the read
        // was abandoned mid-stream — `abandoned` says which. Diagnostic either way: the sentence
        // the user gets names neither number.
        return {
          ok: false,
          failure: {
            reason: "size_mismatch", id,
            declared: t.sizeBytes,
            actual: tooLarge.declaredBytes ?? tooLarge.maxBytes + 1,
            ...(tooLarge.declaredBytes === null ? { abandoned: true } : {}),
          },
        };
      }
      return { ok: false, failure: { reason: "unavailable", id } };
    }
    if (bytes.byteLength > t.sizeBytes) {
      return {
        ok: false,
        failure: { reason: "size_mismatch", id, declared: t.sizeBytes, actual: bytes.byteLength },
      };
    }
    out.push({
      ticketId: t.id,
      filename: t.filename,
      contentType: t.contentType,
      content: Buffer.from(bytes),
    });
  }
  return { ok: true, attachments: out };
}

/**
 * THE MINT'S QUOTA REFUSAL, as the caller sees it.
 *
 * ── 429, AND `retryable: false` ──────────────────────────────────────────────────────────────
 *
 * 429 is the family: the caller is asking for more of a finite resource than its share, and the
 * request would succeed later. It is deliberately not 507, which describes the SERVER being out of
 * room — this deployment is not, and telling an operator otherwise would point an incident at the
 * wrong place.
 *
 * The `retryable: false` is the load-bearing half, and it inverts the client's default. The engine
 * reads `wire.error.retryable ?? (status >= 500 || status === 429)`
 * (`packages/client-engine/src/adapters/http-adapter.ts`), so a bare 429 tells its mutation queue
 * to try again — and this is the one 429 in the product where trying again is exactly wrong.
 * Nothing frees quota except time: a staged ticket has no `consumed_at`, so it is held until it
 * expires, and a retry loop against a full quota is a client spinning against a wall for up to
 * twenty-four hours. The refusal is stated once, to a person, with the number in it.
 *
 * ── THE COPY NAMES THE REMEDY THAT ACTUALLY WORKS ────────────────────────────────────────────
 *
 * Which is waiting, not sending. It would read better to say "send the messages you have
 * composed", and it would be false: sending does not release a ticket, deliberately, so that a
 * send retried under the same idempotency key still finds its bytes. Truthful over flattering.
 */
function stagingQuotaError(refusal: StagingQuotaRefusal): ServiceError {
  const hours = "24 hours";
  const message = refusal.limit === "tickets"
    ? `This account already has ${refusal.outstanding} attachments uploaded and waiting, which is ` +
      `the limit of ${refusal.cap}. Uploads are released ${hours} after they are made, oldest ` +
      "first — try again later, or send fewer files at a time."
    : `This account already has ${refusal.outstanding} bytes of attachments uploaded and waiting, ` +
      `and this file adds ${refusal.requested}; the limit is ${refusal.cap} bytes. Uploads are ` +
      `released ${hours} after they are made, oldest first — try again later, or send smaller ` +
      "files.";
  return new ServiceError(
    "staging_quota_exceeded", 429, message,
    { limit: refusal.limit, cap: refusal.cap, outstanding: refusal.outstanding },
    false,
  );
}

/**
 * THE HOSTED STAGING PORT, over one database handle and one bucket.
 *
 * Two halves that share nothing but the table: `mint` (the row plus the signed grant) and `source`
 * (the two-phase read `SendService` reads through). They are one object because they are one
 * capability — a host either has object storage behind it or it does not, and the shape of
 * `undefined` is what tells a SHARED send handler which host it is running on.
 *
 * ── THE ROW IS WRITTEN BEFORE THE GRANT IS MINTED ─────────────────────────────────────────
 *
 * The other order leaks. An object whose row was never written is an object nothing knows the path
 * of, so the sweep cannot find it and it sits in the bucket for the life of the deployment. A row
 * whose signed URL then failed to mint is the harmless direction: it names an object that does not
 * exist, the caller got an error, and the sweep deletes a row and a storage 404 — which `remove`
 * treats as success precisely so that this case, and every abandoned upload, actually clears.
 */
export function makeAttachmentStagingPort(deps: {
  db: Tx;
  storage: AttachmentStagingStorage;
  /** Mints ticket ids. Injected so a test can make the object path deterministic. */
  newId?: () => string;
  /**
   * The per-account outstanding cap. Injected so a guard can drive the refusal without staging
   * five hundred real rows — the production value is `DEFAULT_STAGING_QUOTA` and every deployment
   * uses it.
   */
  quota?: StagingQuota;
}): {
  mint(input: {
    accountId: string; filename: string; contentType: string; sizeBytes: number; now: Date;
    /**
     * THE CALLER'S `Idempotency-Key`, REQUIRED — see {@link stagingTicketId}. The ticket's id is
     * this key's digest, so a retry after a lost response resolves to the SAME row and the SAME
     * object path instead of minting a second grant against a bucket somebody pays for.
     */
    idempotencyKey: string;
  }): Promise<StagedUploadGrant>;
  source: {
    declare(
      accountId: string, ids: readonly string[],
    ): Promise<Array<{ id: string; sizeBytes: number; expiresAt: Date }>>;
    fetch(accountId: string, ids: readonly string[], now: Date): Promise<SendAttachment[]>;
  };
} {
  const newId = deps.newId ?? (() => randomUUID());
  const quota = deps.quota ?? DEFAULT_STAGING_QUOTA;
  return {
    async mint(input) {
      // A MISSING KEY IS A PROGRAMMING ERROR AND IS LOUD ABOUT IT.
      //
      // The type says required and the route refuses without one, so this can only be reached by a
      // caller that bypassed both. It is worth a runtime throw rather than a shrug because the
      // silent version is catastrophic: `undefined` hashes perfectly well, so every mint on the
      // deployment would derive the SAME ticket id and collapse into one row — every sender's
      // attachment overwriting the last. Found by a fixture that did exactly that.
      const idempotencyKey = (input.idempotencyKey ?? "").trim();
      if (!idempotencyKey) {
        throw new Error("attachment staging mint requires an idempotencyKey — it is the ticket's identity");
      }
      // THE ID IS THE KEY'S DIGEST, not a fresh random. `newId` survives only as the test seam it
      // was introduced as — a fixture that wants a deterministic path without inventing a key.
      const id = deps.newId ? newId() : stagingTicketId(input.accountId, idempotencyKey);
      const objectPath = stagingObjectPath(input.accountId, id);
      // THE QUOTA AND THE INSERT COMMIT TOGETHER, and the network call is strictly outside.
      // `createStagingTicketWithinQuota` takes a per-account advisory lock as its first statement,
      // so the count it reads is the count its own insert extends; holding that lock across the
      // `signUpload` round trip below would turn a slow storage endpoint into a per-account stall,
      // which is why the transaction closes first. The ORDER the module header insists on is
      // unchanged: the row is durable before any grant exists for it.
      const created = await (deps.db as Tx).transaction(
        async (tx) => createStagingTicketWithinQuota(tx as LedgerTx, {
          id,
          accountId: input.accountId,
          objectPath,
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          now: input.now,
        }, quota),
      );
      if (!created.ok) {
        if (created.reason === "quota") throw stagingQuotaError(created.refusal);
        // The key names a ticket whose bytes have aged out. Temporary and self-healing — see
        // `createStagingTicketWithinQuota` — and worded as the send path words the same fact.
        throw new ServiceError(
          "conflict", 409,
          "This upload has expired. Attach the file again and resend.",
          undefined, false,
        );
      }
      const row = created.ticket;
      const grant = await deps.storage.signUpload(objectPath, input.contentType);
      return {
        id: row.id,
        uploadUrl: grant.uploadUrl,
        uploadMethod: grant.uploadMethod,
        uploadHeaders: grant.uploadHeaders,
        expiresAt: row.expiresAt.toISOString(),
      };
    },

    source: {
      async declare(accountId, ids) {
        const rows = await readStagingTickets(deps.db, accountId, ids);
        return rows.map((r) => ({ id: r.id, sizeBytes: r.sizeBytes, expiresAt: r.expiresAt }));
      },
      async fetch(accountId, ids, now) {
        const rows = await readStagingTickets(deps.db, accountId, ids);
        const res = await resolveStagedAttachments(deps.storage, rows, ids, now);
        if (res.ok) return res.attachments.map(({ ticketId: _t, ...a }) => a);
        // EVERY ONE OF THESE ENDS THE SEND. A message that quietly left without a file the
        // composer showed is a wrong send — the same ruling the forward path already made about a
        // failed IMAP stream. The reservation stays `pending` and the user retries under the same
        // key, which is exactly why the ticket is not consumed by a send.
        switch (res.failure.reason) {
          case "unknown":
            throw new ServiceError("not_found", 404, "an uploaded attachment was not found");
          case "expired":
            throw new ServiceError(
              "conflict", 409,
              "an uploaded attachment has expired. Attach the file again and resend.",
            );
          case "size_mismatch":
            throw new ServiceError(
              "payload_too_large", 413,
              "an uploaded attachment is larger than it was declared to be",
            );
          default:
            throw new ServiceError(
              "unavailable", 503,
              "an uploaded attachment could not be read. Try sending again.",
            );
        }
      },
    },
  };
}
