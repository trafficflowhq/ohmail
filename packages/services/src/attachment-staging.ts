/**
 * Attachment staging — the hosted send's direct-upload transport, send-facing half. Bytes once
 * rode the send body base64-encoded under the platform's ~4.5 MB request cap; now they go browser
 * → object storage on a signed URL and the send carries a REFERENCE to an `attachment_staging`
 * row (the inline path stays for older desktops). The TABLE, BUCKET and SWEEP live in
 * `@trafficflow/db/cloud` — the sweep's only caller is the worker. MINT writes the row and THEN
 * mints the signed URL: the other order leaks an object nothing knows the path of. SEND checks
 * the declared total, downloads and RE-MEASURES — the declared size is a client assertion. SWEEP
 * deletes object then row, the only order that cannot orphan bytes.
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
 * Turn staged references into bytes. The declared total is checked by the caller; this is the
 * download, and it re-measures every object against the size its ticket declared — a client that
 * declares 1 MB and uploads 50 is refused HERE, before the send's cap check, because the
 * alternative enforces the cap against a number the attacker chose. `requestedIds` is
 * client-supplied and may repeat a ticket: this loop walks DISTINCT ids, so `storage.download`
 * runs once per object. The route deduplicates too — not redundant: the amplification is a
 * property of this loop, and callers exist that skip the route. Order is first appearance — the
 * composer's file order.
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
       * The ticket's declared size is a CEILING ON THE READ, not a check afterwards. The
       * presigned PUT signs only the content TYPE, so an authenticated caller could mint a
       * one-byte ticket, upload an object of any size, and send it — this process buffered the
       * whole object before noticing: authenticated remote memory exhaustion, repeatable. The
       * ceiling is the ticket's own `sizeBytes`: the port refuses the declared `Content-Length`
       * before reading and abandons the stream at the ceiling. The comparison below is KEPT —
       * unreachable through this port, but `AttachmentStagingStorage` is injectable and a storage
       * that ignores `maxBytes` must still be refused.
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
 * The mint's quota refusal, as the caller sees it. 429 is the family (a finite resource; the
 * request would succeed later), deliberately not 507: the server is not out of room. `retryable:
 * false` is the load-bearing half: the engine reads `wire.error.retryable ?? (status >= 500 ||
 * status === 429)`, so a bare 429 tells the mutation queue to retry — and this is the one 429
 * where retrying is exactly wrong: nothing frees quota except time (a staged ticket has no
 * `consumed_at`; it is held until it expires). The copy names the remedy that works — waiting,
 * not sending: a send does not release a ticket, deliberately, so a send retried under the same
 * idempotency key still finds its bytes.
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
 * The hosted staging port, over one database handle and one bucket. Two halves sharing only the
 * table: `mint` (the row plus the signed grant) and `source` (the two-phase read `SendService`
 * reads through) — one object because a host either has object storage behind it or it does not,
 * and the shape of `undefined` tells a SHARED send handler which host it runs on. The row is
 * written BEFORE the grant is minted: the other order leaks an object nothing knows the path of;
 * a row whose URL failed to mint names an object that does not exist, and the sweep deletes a row
 * and a storage 404 — which `remove` treats as success so abandoned uploads actually clear.
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
    ): Promise<Array<{ id: string; sizeBytes: number; expiresAt: Date; filename: string; contentType: string }>>;
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
        // `filename` and `contentType` ride along beside the size. They are METADATA the mint
        // stored and never content, and the send path folds them into its duplicate fingerprint —
        // which cannot use the ticket id, because a re-send under a fresh key re-stages and mints
        // new ids for the same files. See `StagedAttachmentSource.declare`.
        return rows.map((r) => ({
          id: r.id, sizeBytes: r.sizeBytes, expiresAt: r.expiresAt,
          filename: r.filename, contentType: r.contentType,
        }));
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
