import {
  ServiceError, effectiveAttachmentCap, SEND_ATTACHMENT_FIELD_MAX_CHARS,
  SEND_STAGED_OBJECT_MAX_BYTES,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { mailbox, readBody } from "./shared.js";

/**
 * `POST /attachments/staging` — MINT ONE UPLOAD TICKET. **SERVER COMPOSITIONS ONLY** — the
 * tables that mount it (`routes/index.ts`, `routes/self-host.ts`) belong to deployments that own
 * object storage and receive the send as an HTTP request.
 *
 * ## What it is for
 *
 * Attachment bytes used to ride the send request body base64-encoded, so every hosted send was
 * bound by the platform's ~4.5 MB request limit and the compose surface promised 3 MB whatever the
 * sender's own submission server announced. This mints a signed, single-object upload grant so the
 * browser puts the bytes in storage directly; the send then carries a reference and the form can
 * promise what the mailbox actually accepts. A self-hosted server is in exactly the hosted
 * deployment's position — a browser on one machine, the SMTP dial on another, a request body
 * between them — which is why it mounts this route too, minting grants against its own bucket.
 *
 * ## Why it is not on the local route table
 *
 * `routes/local.ts` deliberately does not name this module — the same mechanism `admin-oauth.ts`
 * and `mailbox-oauth.ts` use. A desktop engine runs its send in the same process as its own SMTP
 * dial, so it has nothing to stage around, and a standalone desktop install that could reach this
 * route would be sending somebody's attachment bytes to a server's storage.
 * Not mounting it is a stronger statement than refusing it, and it is checked from source.
 *
 * ## `cost: "work"` — an unverified account must not create cost, and the frozen census will notice
 *
 * This handler WRITES A ROW AND CREATES STORAGE COST. It is `work` for the same reason
 * `PATCH /consent/settings` is: the class is chosen for what the handler causes, and an account
 * whose address is unproven has no business creating objects in a bucket somebody pays for. It is
 * therefore in the gated remainder, not in any of the three exempt lists — the census in
 * `test/spend-gate.test.ts` moves both of its numbers by one, which is the arithmetic
 * saying a spender did not slip into an exempt class.
 *
 * Not `paid`: nothing metered is debited and no third party bills per call. Not `connection`: it
 * opens no socket to the user's mail server and holds nothing open.
 *
 * ## THE CEILING IS THE MAILBOX'S OWN, AND IT IS THE SAME RULE THE SEND APPLIES
 *
 * `effectiveAttachmentCap(SEND_STAGED_OBJECT_MAX_BYTES, mailbox.smtpMaxSizeBytes)` — the smaller of
 * what the BUCKET will hold and the RFC 1870 `SIZE` the mailbox's submission server announced. A
 * mailbox that has never been probed announces nothing and the answer falls back to the product
 * constant, because an unknown limit read as no limit costs the user a message they composed and
 * waited for.
 *
 * THE SURFACE IS THE BUCKET, NOT `null`, and this is a correction rather than a tightening. It used
 * to declare an explicitly uncapped surface on the reading that a transport with no request body in
 * it has no ceiling. It has one: the bucket refuses an object over its configured `file_size_limit`,
 * and it refuses it in the BROWSER's PUT — after this route answered 201 and after the person
 * waited for the upload. All the client can say then is "try again", which is a retry that can
 * never succeed. Minting a grant this deployment's storage will not accept is the one thing this
 * check exists to prevent, so the bucket's own number is a bound here like any other.
 *
 * That makes the refusal here the SAME number the compose form states and the same number
 * `SendService` will enforce on the total. It is a per-file bound; the TOTAL is the send's, and it
 * is refused there against the declared sizes before a single byte is transferred.
 *
 * ## `Idempotency-Key` IS REQUIRED, AND IT IS READ HERE RATHER THAN BY THE MIDDLEWARE
 *
 * A ticket is a DURABLE ROW plus a grant to put bytes in a bucket somebody pays for. Minted
 * without a stable key, a retry after a lost response mints a SECOND row and uploads a SECOND
 * copy — and the client cannot tell the two apart, because the only thing that ever named the
 * first ticket was the response it did not receive. So the key is required and the request is
 * refused without one, exactly as `POST /drafts/:id/send` refuses a send without one.
 *
 * **It deliberately does NOT carry `options: { idempotent: true }`**, and that is not an
 * oversight to be tidied up later. `withIdempotency` replays a STORED RESPONSE, and this
 * response contains a SIGNED URL with a lifetime of its own — replaying it would hand a client a
 * grant that may already have expired, and the handler could not store the response inside its
 * mutation transaction anyway, because the URL is signed strictly AFTER that transaction commits
 * (the module header explains why that order cannot be reversed without leaking objects).
 *
 * The key is therefore spent where it can actually be honoured: the ticket's PRIMARY KEY is the
 * key's digest (`stagingTicketId`), so a retry finds the same row, re-signs a fresh grant for the
 * same object path, and consumes no additional quota. The durable record IS the lock.
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
       * THE SAME CEILING THE INLINE ENTRANCE APPLIES, AT THE OTHER ENTRANCE.
       *
       * `routes/drafts.ts#decodeSendAttachments` holds an inline attachment's `filename` and
       * `contentType` to {@link SEND_ATTACHMENT_FIELD_MAX_CHARS}, because both become MIME header
       * parameters on the outgoing message. A STAGED attachment's are the same parameters,
       * reaching the same builder by a different road, and nothing bounded them here.
       *
       * The failure is a fan-in the door cannot see: each mint is its own request, so the 3 MiB
       * body ceiling bounds each filename INDEPENDENTLY, and a caller may hold
       * `STAGING_MAX_OUTSTANDING_TICKETS` of them at once. One send referencing all of them asks
       * this process to build a message whose headers are the SUM — hundreds of megabytes of
       * caller-chosen text, from requests every one of which was individually legal. A per-request
       * ceiling is not a bound on a value that persists and is later gathered.
       *
       * Applied to the trimmed value, so a filename that is only long because of whitespace is
       * accepted rather than refused for a length it does not have.
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
