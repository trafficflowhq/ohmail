import { ServiceError, type CreateDraftBody, type PatchDraftBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import { makeSendAdapter } from "../send-adapter.js";
import { makeOpenAdapter } from "../attachments-adapter.js";
import type { Route } from "../router.js";
import { drafts, sends, readBody } from "./shared.js";

/**
 * THE SEND REQUEST'S BODY — everything the delivery needs beyond the stored draft, and nothing
 * that is kept. `attachments` carries file bytes as base64 (JSON is the transport the send route
 * has always used); they are decoded here and handed to `SendService` as raw bytes that reach the
 * `OutboundMessage` and no table. An ordinary send sends no body at all — `readBody` returns `{}`.
 */
interface SendAttachmentWire { filename?: string; contentType?: string; contentBase64?: string }
interface SendRequestBody {
  attachments?: SendAttachmentWire[];
  /** Forward this original — the server reads it, refuses a no_forward one, and quotes it. */
  forwardOf?: string;
}

/** base64 → raw bytes, with lenient defaults; the total is capped in `SendService.reserve`. */
function decodeSendAttachments(
  items: SendAttachmentWire[] | undefined,
): Array<{ filename: string; contentType: string; content: Buffer }> | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  return items.map((a) => ({
    filename: typeof a.filename === "string" && a.filename.length > 0 ? a.filename : "attachment",
    contentType: typeof a.contentType === "string" && a.contentType.length > 0
      ? a.contentType
      : "application/octet-stream",
    content: Buffer.from(typeof a.contentBase64 === "string" ? a.contentBase64 : "", "base64"),
  }));
}

/**
 * §5 /drafts — manual compose drafts (Phase 3a). create/update/delete emit a
 * `draft` change (X-Sync-Seq echoed from the emitted seq, §3.4) so drafts flow
 * through /sync; `materializeDraft` (R-P3-4) keeps them from tombstoning. A draft
 * is STORED, never auto-sent (the AI drafter is 3b, the gated send is 3c — not
 * built here). All account-scoped in the service (404 cross-account); an
 * invalid/foreign mailboxId → 400.
 */
export const draftsRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/drafts",
    cost: "work",
    handler: async (req, deps) => {
      const body = await readBody<CreateDraftBody>(req);
      const { draft, seq } = await drafts(deps).create(serviceContext(deps, req), body);
      return jsonResponse(draft, { status: 201, seq });
    },
  },
  {
    method: "GET",
    pattern: "/drafts/:id",
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await drafts(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "PUT",
    pattern: "/drafts/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      const patch = await readBody<PatchDraftBody>(req);
      const { draft, seq } = await drafts(deps).update(serviceContext(deps, req), params.id!, patch);
      return jsonResponse(draft, { status: 200, seq });
    },
  },
  {
    method: "DELETE",
    pattern: "/drafts/:id",
    cost: "work",
    handler: async (req, deps, params) => {
      const { seq } = await drafts(deps).remove(serviceContext(deps, req), params.id!);
      return new Response(null, { status: 204, headers: { "X-Sync-Seq": String(seq) } });
    },
  },
  {
    // §5 POST /drafts/:id/send — the GATED IDEMPOTENT send (Phase 3c). Session +
    // CSRF (default pipeline); deliberately NOT idempotent-marked (R-P3-3) — the
    // generic verbatim idempotency cache can't model the `pending` reservation, so
    // SendService owns `outbound_sends` and this handler reads `Idempotency-Key`
    // itself (400 if absent). The reservation is minted + persisted BEFORE the
    // out-of-tx SMTP call and verified-by-Sent on retry, so a crash never yields a
    // double-send. `makeSendAdapter` reads BOTH imap+smtp creds (R-P3-5).
    method: "POST",
    pattern: "/drafts/:id/send",
    // `connection` rather than `paid`: it opens SMTP (and IMAP, to verify by Sent) on the
    // user's own server and debits nothing metered. Sending mail from an address nobody has
    // proven belongs to the sender is also a deliverability-reputation liability, not only a
    // cost one.
    cost: "connection",
    handler: async (req, deps, params) => {
      const key = req.headers.get("idempotency-key");
      if (!key) throw new ServiceError("validation_failed", 400, "Idempotency-Key header is required");
      // Attachment bytes ride here — decoded to raw and handed to the service, never persisted. An
      // ordinary send carries no body, so `readBody` answers `{}` and this is `undefined`.
      const body = await readBody<SendRequestBody>(req);
      const attachments = decodeSendAttachments(body.attachments);
      const forwardOf = typeof body.forwardOf === "string" && body.forwardOf.length > 0 ? body.forwardOf : undefined;
      // Prod: decrypt both imap+smtp creds → connected ImapAdapter (R-P3-5). Tests
      // may inject a fake/GreenMail send spy via `deps.services.sendAdapter`.
      const openSendAdapter = deps.services?.sendAdapter ?? ((mailboxId: string) => makeSendAdapter(deps, mailboxId));
      // Only ever OPENED on a forward (SendService calls it lazily), so a normal send builds this
      // factory and never dials. Streams the forwarded original's attachments from the user's own
      // IMAP, straight onto the outgoing message, never persisted.
      const openFetchAdapter = makeOpenAdapter(deps);
      const result = await sends(deps).send(
        serviceContext(deps, req), params.id!, key,
        {
          openSendAdapter, openFetchAdapter,
          // WHICH HOST IS CARRYING THESE BYTES. Absent on the hosted API, which resolves to the
          // serverless body limit; `null` from the local engine, which has no request pipeline
          // between this handler and SMTP. `SendService` takes the SMALLER of this and the
          // mailbox's own announced `SIZE`, so neither host can send past what the user's mail
          // server said it will accept.
          surfaceMaxTotalBytes: deps.services?.sendSurfaceMaxTotalBytes,
        },
        { attachments, forwardOf },
      );
      switch (result.status) {
        case "sent":
          return jsonResponse(
            { status: "sent", providerMessageId: result.providerMessageId },
            { status: 200, seq: result.seq ?? undefined },
          );
        case "unverified":
          return jsonResponse(
            {
              status: "unverified",
              message: "We couldn't confirm this send. Check your Sent folder before retrying.",
            },
            { status: 200, seq: result.seq ?? undefined },
          );
        case "failed":
          return jsonResponse(
            { status: "failed", message: "A prior send under this key failed and was not delivered." },
            { status: 409 },
          );
        default:
          return jsonResponse(
            { status: "in_flight", message: "A send for this draft is already in progress." },
            { status: 409 },
          );
      }
    },
  },
];
