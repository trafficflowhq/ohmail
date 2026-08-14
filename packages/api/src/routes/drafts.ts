import { ServiceError, type CreateDraftBody, type PatchDraftBody } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import { makeSendAdapter } from "../send-adapter.js";
import { makeOpenAdapter } from "../attachments-adapter.js";
import type { Route } from "../router.js";
import { drafts, sends, readBody } from "./shared.js";

/**
 * THE SEND REQUEST'S BODY — everything the delivery needs beyond the stored draft, and nothing
 * that is kept.
 *
 * ── TWO ACCEPTED SHAPES FOR ATTACHMENTS, AND BOTH ARE LIVE ────────────────────────────────
 *
 * `attachments` carries file bytes as base64 on this request. It is the original transport and it
 * is the LIVE one — not a compatibility shim awaiting a sunset, and the difference is worth
 * stating because the compatibility reading is the easy one to reach and it is wrong.
 *
 * EVERY CLIENT THAT SHIPS TODAY EMITS THIS SHAPE:
 *  · the browser app stages only ABOVE the inline ceiling (`SEND_INLINE_MAX_TOTAL_BYTES`, the same
 *    3 MB this handler caps at), so every send at or under it — which is nearly all of them — is
 *    exactly this request;
 *  · the desktop app never stages on EITHER door. The wire client's staging option defaults off
 *    and that app's source does not contain its name, so its Cloud door forwards this shape at any
 *    size, and its standalone door has no hosted storage behind it to stage into.
 *
 * So the reason to keep accepting it is NOT "installed copies have not updated yet". Update uptake
 * is not the question and cannot settle it: the current release emits this shape too, and no
 * client-version signal reaches this API in any case. Removing the inline form would first require
 * the desktop's Cloud door to stage and the browser client to stage unconditionally, and until
 * both of those are true this paragraph is the answer to "can we drop it yet".
 *
 * A request in this shape produces byte-identical behaviour to the day it was the only shape.
 *
 * `stagedAttachmentIds` names upload tickets whose bytes are already in object storage, put
 * there by the browser on a signed URL from `POST /attachments/staging`. This is the
 * transport that lifts the ~4.5 MB serverless body limit off the feature and lets the compose form
 * promise what the sending mailbox actually announced.
 *
 * A send may carry either or both. The service concatenates them (inline first) and applies one
 * cap to the total — and the cap's SURFACE term depends on which shapes are present, because a
 * request-body limit is not a statement about bytes that never rode the request body. See
 * `sendSurfaceFor` in the send service.
 *
 * Neither shape is persisted. Both reach the one `OutboundMessage` and no table; the staged bytes
 * additionally existed in a bucket for a bounded window on the way here, which is the fact the
 * privacy copy states.
 *
 * An ordinary send sends no body at all — `readBody` returns `{}`.
 */
interface SendAttachmentWire { filename?: string; contentType?: string; contentBase64?: string }
interface SendRequestBody {
  attachments?: SendAttachmentWire[];
  /** Upload-ticket ids. Account-scoped in the service; a foreign id is a 404. */
  stagedAttachmentIds?: unknown;
  /** Forward this original — the server reads it, refuses a no_forward one, and quotes it. */
  forwardOf?: string;
}

/** The staged reference list, validated to strings. Absent/empty ⇒ `undefined`, so an inline-only
 *  send builds the exact `SendInput` it always did. */
function readStagedIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return ids.length > 0 ? ids : undefined;
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
      const stagedAttachmentIds = readStagedIds(body.stagedAttachmentIds);
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
          //
          // For a send whose bytes are STAGED the service resolves this to `null` itself — those
          // bytes did not ride this host's request body, so a declaration about that body says
          // nothing about them. `sendSurfaceFor` holds that rule; this stays the host's honest
          // statement about its own pipeline.
          surfaceMaxTotalBytes: deps.services?.sendSurfaceMaxTotalBytes,
          // WHERE STAGED BYTES COME FROM. Absent on a host with no object storage — a local
          // install — and then a request naming staged references is REFUSED rather than sent
          // without its files.
          ...(deps.services?.attachmentStaging
            ? { stagedAttachments: deps.services.attachmentStaging(deps.db).source }
            : {}),
        },
        { attachments, stagedAttachmentIds, forwardOf },
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
