import {
  ServiceError, effectiveAttachmentCap, SEND_ATTACHMENT_FIELD_MAX_CHARS,
  SEND_STAGED_OBJECT_MAX_BYTES,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { mailbox, readBody } from "./shared.js";

/**
 * `POST /attachments/staging` — mint one upload ticket. Server compositions only: a desktop
 * engine has nothing to stage around — `routes/local.ts` does not name this module, checked from
 * source. `cost: "work"`: it writes a row and creates storage cost. The ceiling is the mailbox's
 * own (`effectiveAttachmentCap(SEND_STAGED_OBJECT_MAX_BYTES, mailbox.smtpMaxSizeBytes)`) — the
 * number the compose form states and the send enforces. `Idempotency-Key` is required and read
 * here, not by the middleware: `withIdempotency` replays a stored response, and this one carries
 * a signed URL with its own lifetime — instead the ticket's primary key is the key's digest, so a
 * retry finds the same row and re-signs a fresh grant. The durable record is the lock.
 */

interface MintBody {
  mailboxId?: unknown;
  filename?: unknown;
  contentType?: unknown;
  sizeBytes?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export const attachmentStagingRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/attachments/staging",
    relay: true,
    cost: "work",
    handler: async (req, deps) => {
      const makeStaging = deps.services?.attachmentStaging;
      if (!makeStaging) {
        // A hosted deployment whose storage is unconfigured. 503 rather than 404: the route
        // exists, the deployment is incomplete, and telling the client "not found" would send it
        // down the inline fallback while reporting nothing an operator could act on.
        throw new ServiceError("unavailable", 503, "attachment staging is not configured on this deployment");
      }
      const ctx = serviceContext(deps, req);

      // THE KEY, BEFORE ANYTHING IS READ OR WRITTEN. See the header for why this route reads the
      // header itself rather than mounting `withIdempotency`.
      const idempotencyKey = (req.headers.get("idempotency-key") ?? "").trim();
      if (!idempotencyKey) {
        throw new ServiceError(
          "validation_failed", 400,
          "Idempotency-Key is required. Reload the page and try again.",
        );
      }
      // A bound, because the key is hashed into a primary key and an unbounded header is an
      // unbounded digest input on a route an authenticated caller can make. 255 is a length no
      // legitimate key needs — the client's is a send's key plus a small index — and it is
      // deliberately NOT read as a promise about `idempotency_keys.key`, which is `text` and
      // unbounded; this bound is this route's, for this route's reason.
      if (idempotencyKey.length > 255) {
        throw new ServiceError("validation_failed", 400, "Idempotency-Key is too long");
      }

      const body = await readBody<MintBody>(req);

      /**
       * The same ceiling the inline entrance applies, at the other entrance:
       * `decodeSendAttachments` holds an inline attachment's `filename` and `contentType` to
       * {@link SEND_ATTACHMENT_FIELD_MAX_CHARS} because both become MIME header parameters, and a
       * staged attachment's reach the same builder by a different road. The failure is a fan-in
       * the door cannot see: each mint is its own request, so the body ceiling bounds each
       * filename independently, and one send referencing every outstanding ticket asks for
       * headers that are the sum. Applied to the trimmed value.
       */
      const filename = str(body.filename) || "attachment";
      const contentType = str(body.contentType) || "application/octet-stream";
      for (const [field, v] of [["filename", filename], ["contentType", contentType]] as const) {
        if (v.length > SEND_ATTACHMENT_FIELD_MAX_CHARS) {
          throw new ServiceError(
            "validation_failed", 400,
            `${field} must be at most ${SEND_ATTACHMENT_FIELD_MAX_CHARS} characters`,
          );
        }
      }
      const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : Number.NaN;
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || !Number.isInteger(sizeBytes)) {
        throw new ServiceError("validation_failed", 400, "sizeBytes must be a positive integer");
      }

      // THE SENDING MAILBOX DECIDES THE CEILING, so the client must name it. Read through
      // `MailboxService` rather than the table, so the account scoping is the one every other
      // mailbox read already has — a foreign or unknown id is its 404, not a bigger allowance.
      const mailboxId = str(body.mailboxId);
      if (!mailboxId) {
        throw new ServiceError("validation_failed", 400, "mailboxId is required");
      }
      const mb = await mailbox(deps).get(ctx, mailboxId);
      const cap = effectiveAttachmentCap(SEND_STAGED_OBJECT_MAX_BYTES, mb.smtpMaxSizeBytes ?? null);
      if (sizeBytes > cap) {
        throw new ServiceError(
          "payload_too_large", 413,
          `attachment is ${sizeBytes} bytes; the limit is ${cap}`,
        );
      }

      const grant = await makeStaging(deps.db).mint({
        accountId: ctx.accountId, filename, contentType, sizeBytes, now: ctx.now(),
        idempotencyKey,
      });
      return jsonResponse(grant, { status: 201 });
    },
  },
];
