import { ServiceError, effectiveAttachmentCap } from "@trafficflow/services/mail";
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
 * `effectiveAttachmentCap(null, mailbox.smtpMaxSizeBytes)` — an EXPLICITLY UNCAPPED surface, which
 * is the honest description of a transport with no request body in it, bounded by the RFC 1870
 * `SIZE` the mailbox's submission server announced. A mailbox that has never been probed announces
 * nothing and the answer falls back to the product constant, because an unknown limit read as no
 * limit costs the user a message they composed and waited for.
 *
 * That makes the refusal here the SAME number the compose form states and the same number
 * `SendService` will enforce on the total. It is a per-file bound; the TOTAL is the send's, and it
 * is refused there against the declared sizes before a single byte is transferred.
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
      const body = await readBody<MintBody>(req);

      const filename = str(body.filename) || "attachment";
      const contentType = str(body.contentType) || "application/octet-stream";
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
      const cap = effectiveAttachmentCap(null, mb.smtpMaxSizeBytes ?? null);
      if (sizeBytes > cap) {
        throw new ServiceError(
          "payload_too_large", 413,
          `attachment is ${sizeBytes} bytes; the limit is ${cap}`,
        );
      }

      const grant = await makeStaging(deps.db).mint({
        accountId: ctx.accountId, filename, contentType, sizeBytes, now: ctx.now(),
      });
      return jsonResponse(grant, { status: 201 });
    },
  },
];
