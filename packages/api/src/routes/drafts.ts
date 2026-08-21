import {
  ServiceError, SEND_MAX_ATTACHMENT_PARTS, dedupeStagedIds,
  type CreateDraftBody, type PatchDraftBody,
} from "@trafficflow/services/mail";
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

/**
 * WHY BOTH LISTS ARE COUNTED HERE, AT THE DOOR.
 *
 * The byte ceiling the send enforces bounds neither list's LENGTH, and reading it as if it did is
 * what left both of them open. A staged reference weighs whatever its ticket DECLARED — the mint's
 * floor is one byte — and an inline entry that carries no `contentBase64` decodes to zero bytes and
 * so weighs nothing at all. Either way a caller can name arbitrarily many parts and stay under
 * every byte cap in the path; the only thing that was bounding them was how many fit in a request
 * body, which is not a product rule.
 *
 * So the length is refused here rather than deeper in: it is a fact about the REQUEST, knowable
 * before a transaction is opened or an object is fetched, and an answer carrying both numbers is
 * one a client can act on. See {@link SEND_MAX_ATTACHMENT_PARTS} for where 100 comes from.
 *
 * `payload_too_large`/413 rather than a 400, and the RAW list length rather than the deduplicated
 * one, because `MarkSeenBody`'s cap on `PATCH /messages` (`MARK_SEEN_MAX_IDS`) already decided both
 * for the same shape of request — a client-supplied id array on one write — and answers 413 on the
 * array it was handed, then deduplicates what is left. Two id lists on one API disagreeing about
 * which status a length refusal carries, or about whether repeats count toward it, would be a
 * distinction a client has to learn per route.
 */
function refuseOverLongList(kind: "attachments" | "staged attachments", n: number): void {
  if (n > SEND_MAX_ATTACHMENT_PARTS) {
    throw new ServiceError(
      "payload_too_large", 413,
      `${kind} must contain at most ${SEND_MAX_ATTACHMENT_PARTS} entries; this request named ${n}`,
    );
  }
}

/**
 * The staged reference list, validated to strings and DEDUPLICATED. Absent/empty ⇒ `undefined`, so
 * an inline-only send builds the exact `SendInput` it always did.
 *
 * ── THE SAME TICKET TWICE IS COLLAPSED, NOT REFUSED ─────────────────────────────────────────
 *
 * A staged id names an OBJECT, so naming it twice names one file — and before this, each naming
 * was a separate `storage.download` of the same bytes plus a second copy of the file on the
 * message the recipient got. One authenticated request bought as many round trips as it had room
 * for ids.
 *
 * A skip rather than a 400, because that is the ruling the product already made one surface up:
 * `ComposeAttach` collapses a re-picked file with *"THE SAME FILE TWICE IS A SKIP, NOT A SECOND
 * ROW"* and says so in the muted register, because nothing went wrong. Refusing here would
 * contradict the form the user is actually looking at, and would spend a composed message on what
 * is at worst a client bug. `dedupeStagedIds` is the send service's own function rather than a
 * second copy of the rule — the service dedupes at its own boundary too, and the two must not be
 * able to disagree about what a duplicate is.
 *
 * The count is checked on the list AS SENT, before the dedupe — see {@link refuseOverLongList} for
 * why that order rather than the other. The two rules do not fight: the ceiling bounds how many
 * references one request may name, and the dedupe decides how many files those references are.
 */
function readStagedIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  refuseOverLongList("staged attachments", raw.length);
  const ids = dedupeStagedIds(
    raw.filter((v): v is string => typeof v === "string" && v.length > 0),
  );
  return ids.length > 0 ? ids : undefined;
}

/**
 * base64 → raw bytes, with lenient defaults; the total is capped in `SendService.reserve`, and the
 * COUNT here — see {@link refuseOverLongList}, which is the only bound this list has.
 *
 * NOT deduplicated, and the asymmetry with the staged list above is deliberate. An inline entry
 * CARRIES its bytes: a caller that names the same file twice pays for it twice and is charged for
 * it twice against the cap, so there is nothing to amplify. Collapsing it would mean hashing every
 * attachment's bytes on the send path to undo something the compose form already did on the
 * bytes it had in hand.
 */
function decodeSendAttachments(
  items: SendAttachmentWire[] | undefined,
): Array<{ filename: string; contentType: string; content: Buffer }> | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  refuseOverLongList("attachments", items.length);
  return items.map((a) => ({
    filename: typeof a.filename === "string" && a.filename.length > 0 ? a.filename : "attachment",
    contentType: typeof a.contentType === "string" && a.contentType.length > 0
      ? a.contentType
      : "application/octet-stream",
    content: Buffer.from(typeof a.contentBase64 === "string" ? a.contentBase64 : "", "base64"),
  }));
}

/**
 * §5 /drafts — manual compose drafts. create/update/delete emit a
 * `draft` change (X-Sync-Seq echoed from the emitted seq, §3.4) so drafts flow
 * through /sync; `materializeDraft` keeps them from tombstoning. A draft
 * is STORED, never auto-sent (the AI drafter and the gated send are their own
 * routes, not these). All account-scoped in the service (404 cross-account); an
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
    // §5 POST /drafts/:id/send — the GATED IDEMPOTENT send. Session +
    // CSRF (default pipeline); deliberately NOT idempotent-marked — the
    // generic verbatim idempotency cache can't model the `pending` reservation, so
    // SendService owns `outbound_sends` and this handler reads `Idempotency-Key`
    // itself (400 if absent). The reservation is minted + persisted BEFORE the
    // out-of-tx SMTP call and verified-by-Sent on retry, so a crash never yields a
    // double-send. `makeSendAdapter` reads BOTH imap+smtp creds.
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
      // Prod: decrypt both imap+smtp creds → connected ImapAdapter. Tests
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
          // THE STORAGE CAP for the sent-copy projection. Every live host declares one
          // (`ApiDeps.storageCapOf` — the hosted deployment's subscription read, the local
          // hosts' typed UNMETERED). Passed through as-is: ABSENT means the service REFUSES
          // the projection (never unmetered) — `SendDeps.resolveStorageCap` carries the rule.
          ...(deps.services?.storageCapOf ? { resolveStorageCap: deps.services.storageCapOf } : {}),
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
