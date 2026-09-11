import {
  ServiceError, SEND_ATTACHMENT_FIELD_MAX_CHARS, SEND_MAX_ATTACHMENT_PARTS, dedupeStagedIds,
  requireUuid,
  type CreateDraftBody, type PatchDraftBody, type SendResolution,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import { makeSendAdapter } from "../send-adapter.js";
import { makeOpenAdapter } from "../attachments-adapter.js";
import type { Route } from "../router.js";
import { drafts, schedules, sends, readBody } from "./shared.js";

/**
 * The send request's body — everything the delivery needs beyond the stored draft, nothing kept.
 * Two attachment shapes, both live: `attachments` carries bytes as base64 — the browser stages
 * only above the inline ceiling and the desktop app never stages, so nearly every send is this
 * shape; removing it would first require both clients to stage unconditionally.
 * `stagedAttachmentIds` names upload tickets already in object storage — the transport that lifts
 * the serverless body limit. Either or both; the service concatenates (inline first) and applies
 * one cap whose surface term depends on the shapes present (`sendSurfaceFor`). Neither is
 * persisted. An ordinary send sends no body at all.
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
 * Why both lists are counted here, at the door: the byte ceiling bounds neither list's length — a
 * staged reference weighs whatever its ticket declared (the floor is one byte), an inline entry
 * with no `contentBase64` weighs nothing — so a caller can name arbitrarily many parts under
 * every byte cap. Length is a fact about the request, knowable before a transaction or a fetch.
 * See {@link SEND_MAX_ATTACHMENT_PARTS}. 413 on the raw list length, not the deduplicated one,
 * because `MARK_SEEN_MAX_IDS` already decided both for the same shape — two id lists disagreeing
 * about a length refusal is a distinction a client learns per route.
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
 * The staged reference list, validated to strings and deduplicated. Absent/empty ⇒ `undefined`,
 * so an inline-only send builds the exact `SendInput` it always did. The same ticket twice is
 * collapsed, not refused: a staged id names an object, and each naming used to be a separate
 * `storage.download` plus a second copy on the message. A skip rather than a 400 because the
 * product already ruled it one surface up — `ComposeAttach` collapses a re-picked file, and
 * refusing here would contradict the form the user is looking at. `dedupeStagedIds` is the send
 * service's own function — the two must not disagree. The count is checked before the dedupe
 * ({@link refuseOverLongList}).
 */
function readStagedIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  refuseOverLongList("staged attachments", raw.length);
  const ids = dedupeStagedIds(
    raw.filter((v): v is string => typeof v === "string" && v.length > 0),
  );
  // SHAPE, before the list becomes an `inArray` against `attachment_staging.id`. The count
  // ceiling above bounds how MANY references a request may name and says nothing about what they
  // are, so `{"stagedAttachmentIds":["x"]}` reached a uuid column, PostgreSQL answered 22P02, and
  // an authenticated caller got a 500 for a plainly bad body. The `identifier` disposition in the
  // input census means "the shape test is the bound"; here there was no shape test.
  for (const id of ids) requireUuid(id, "stagedAttachmentIds");
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
/**
 * One attachment's `filename` or `contentType`: a non-empty string inside the field ceiling, or
 * `null` for an absent one (the caller gets this route's own fallback).
 *
 * A 400 rather than a truncation: a filename cut in half is a file the recipient cannot identify,
 * and a truncated media type is one their client will not render.
 */
function shortField(v: unknown, name: string): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  if (v.length > SEND_ATTACHMENT_FIELD_MAX_CHARS) {
    throw new ServiceError(
      "validation_failed", 400,
      `an attachment ${name} is ${v.length} characters; the limit is ${SEND_ATTACHMENT_FIELD_MAX_CHARS}`,
    );
  }
  return v;
}

function decodeSendAttachments(
  items: SendAttachmentWire[] | undefined,
): Array<{ filename: string; contentType: string; content: Buffer }> | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  refuseOverLongList("attachments", items.length);
  return items.map((a) => ({
    // ── THE TWO STRINGS ARE BOUNDED TOO, and only the COUNT and the BYTES were ────────────
    //
    // `SEND_MAX_ATTACHMENT_PARTS` bounds how many entries there are and
    // `SEND_ATTACHMENT_MAX_TOTAL_BYTES` bounds their content; these two were bounded by neither,
    // and they are not content — they become MIME header parameters on the outgoing message. A
    // hundred entries carrying a megabyte filename each is a message whose HEADERS are a hundred
    // megabytes, built by this process. See {@link SEND_ATTACHMENT_FIELD_MAX_CHARS}.
    filename: shortField(a.filename, "filename") ?? "attachment",
    contentType: shortField(a.contentType, "contentType") ?? "application/octet-stream",
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
    // `idempotent: true` because a CREATE is the one draft mutation whose replay mints a
    // SECOND row: the compose surface autosaves through here once per draft and the engine's
    // durable outbox replays a lost-response attempt under the same Idempotency-Key — after a
    // restart, hours later. The service claims the key INSIDE the transaction that writes the
    // row (`DraftsService.create`), storing the 201 body it answered with, so the replay gets
    // the same draft back instead of an orphan twin. Update/discard need none of this: a PUT
    // sets the same values twice and a DELETE of the deleted answers 404, both convergent.
    method: "POST",
    pattern: "/drafts",
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps) => {
      const body = await readBody<CreateDraftBody>(req);
      const { draft, seq } = await drafts(deps).create(serviceContext(deps, req), body, {
        idempotency: deps.idempotency
          ? {
              key: deps.idempotency.key,
              requestHash: deps.idempotency.requestHash,
              responseStatus: 201,
              // The stored body IS the answer below: the in-tx materialized DTO, so a replay
              // is byte-for-byte the first response (same row, same timestamps).
              response: (r) => r.draft,
            }
          : undefined,
      });
      return jsonResponse(draft, { status: 201, seq });
    },
  },
  {
    method: "GET",
    pattern: "/drafts/:id",
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await drafts(deps).get(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "PUT",
    pattern: "/drafts/:id",
    relay: true,
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
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      const { seq } = await drafts(deps).remove(serviceContext(deps, req), params.id!);
      return new Response(null, { status: 204, headers: { "X-Sync-Seq": String(seq) } });
    },
  },
  {
    /**
     * A person answers for a send we could not confirm — `{ outcome: 'arrived' | 'not_arrived'
     * }`. The one exit from the held state: `unverified` means this server genuinely does not
     * know whether the mail went out, and the reader is the only party who can look in the folder
     * that settles it. `arrived` records the delivery and takes the row out of Drafts;
     * `not_arrived` returns it to an ordinary draft. `cost: "work"`, not `connection`: no socket
     * — a state transition on two rows, and the reader's own eyes are the network call. Not
     * idempotent-marked: the service's compare-and-swap on `unverified` makes a repeat converge
     * by itself.
     */
    method: "POST",
    pattern: "/drafts/:id/resolve",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<{ outcome?: unknown }>(req);
      const { draft, seq } = await drafts(deps).resolve(
        serviceContext(deps, req), params.id!, body.outcome as SendResolution,
      );
      return jsonResponse(draft, { status: 200, seq });
    },
  },
  {
    // SEND LATER (mail 0077): put an appointment on a draft. A DRAFT-STATE TRANSITION and
    // nothing else — no reservation is minted, no network is opened, and the worker's
    // scheduled-send pass is what runs the gated send when the time comes. Deliberately NOT
    // idempotent-marked and carrying no Idempotency-Key requirement: setting `send_at` twice to
    // one value is one appointment, so the natural retry converges by itself. `cost: "work"`
    // like the other draft mutations, because that is what it is.
    method: "POST",
    pattern: "/drafts/:id/schedule",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      const body = await readBody<{ sendAt?: unknown }>(req);
      const { draft, seq } = await schedules(deps).schedule(
        serviceContext(deps, req), params.id!, body.sendAt,
      );
      return jsonResponse(draft, { status: 200, seq });
    },
  },
  {
    // SEND LATER: take the appointment off. Race-safe against the worker's claim — the service
    // answers 409 "already being sent" when the claim won, never a false "cancelled"; a repeat
    // cancel of an already-plain draft is idempotent success (the asked-for state).
    method: "DELETE",
    pattern: "/drafts/:id/schedule",
    relay: true,
    cost: "work",
    handler: async (req, deps, params) => {
      const { draft, seq } = await schedules(deps).cancel(serviceContext(deps, req), params.id!);
      return jsonResponse(draft, { status: 200, seq });
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
    relay: true,
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
        case "queued":
          // 202 ACCEPTED, and the code is the whole statement: the reservation is committed and
          // this request stopped waiting for the submission at the attempt ceiling. It is NOT a
          // 200 — nothing is known to have been delivered — and NOT a 409 like `in_flight`, which
          // refuses a SECOND request while someone else's attempt runs. This is the owning
          // request's own answer, and the only send outcome a first press can get that is neither
          // settled nor a refusal.
          //
          // `X-Sync-Seq` rides it: the reservation's own draft change (`sending`) is a committed
          // row the client must drain past, and it exists whether or not the submission lands.
          return jsonResponse(
            {
              status: "queued",
              message: "This send was accepted and is still being handed to your mail server.",
            },
            { status: 202, seq: result.seq ?? undefined },
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
