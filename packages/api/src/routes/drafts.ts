import {
  ServiceError, SEND_ATTACHMENT_FIELD_MAX_CHARS, SEND_MAX_ATTACHMENT_PARTS, dedupeStagedIds, readForwardParts,
  requireUuid, parseReaderLocale, parseReaderZone,
} from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { lookupIdempotent } from "../idempotency.js";
import { answer, answerBuilt } from "../responses.js";
import { makeSendAdapter } from "../send-adapter.js";
import { SEND_KEY_MAX, sendDepsOf, sendKeyOf } from "../send-deps.js";
import type { Route } from "../router.js";
import { drafts, schedules, sends, readBody } from "./shared.js";
import type {
  CreateDraftBody,
  PatchDraftBody,
  RequestOf,
  SendAttachmentWire,
  SendResolution,
  UntrustedBody,
} from "@ohmail/wire";

/** One file of a send as the request carries it, declared with the wire's vocabulary beside the send's body. */

/** A parsed value, or `undefined` where the parser refused it. */
function unlessMalformed<T>(parse: () => T | undefined): T | undefined {
  try {
    return parse();
  } catch {
    return undefined;
  }
}

/**
 * The vouched revision, shape-checked. An opaque server-minted sha-256 hex digest, so the shape
 * IS the bound — and a malformed one is a 400 rather than a 409: answering "this draft changed"
 * to a caller whose token was never a revision would name the wrong fault.
 */
export function readContentRevision(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) {
    throw new ServiceError(
      "validation_failed", 400,
      "ifContentRevision must be a draft revision as the server issued it",
    );
  }
  return raw;
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
export function readStagedIds(raw: unknown): string[] | undefined {
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

export function decodeSendAttachments(
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

/** The send's key and its bound, read where every route that sends reads them (`send-deps.ts`). */
export { SEND_KEY_MAX };

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
    wire: true,
    relay: true,
    cost: "work",
    options: { idempotent: true },
    handler: async (req, deps) => {
      const body = await readBody<RequestOf<"POST /drafts">>(req);
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
      return answer<"POST /drafts">()(draft, { status: 201, seq });
    },
  },
  {
    method: "GET",
    pattern: "/drafts/:id",
    wire: true,
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const ctx = serviceContext(deps, req);
      if (new URL(req.url).searchParams.get("by") === "create-key") {
        const key = params.id!;
        const receipt = key.length <= SEND_KEY_MAX ? await lookupIdempotent(deps.db, ctx.accountId, key, ctx.now()) : null;
        if (key.length <= SEND_KEY_MAX && receipt === null) {
          throw new ServiceError("draft_create_missing", 404, "draft create not found");
        }
        const created = receipt?.responseJson as { id?: unknown; status?: unknown; contentRevision?: unknown } | null;
        if (!receipt || receipt.responseStatus !== 201 || receipt.erasedAt || created?.status !== "draft"
          || typeof created.id !== "string" || typeof created.contentRevision !== "string") {
          throw new ServiceError("not_found", 404, "draft not found");
        }
        const dto = await drafts(deps).get(ctx, created.id);
        return answer<"GET /drafts/:id">()({ ...dto, createdRevision: created.contentRevision });
      }
      return answer<"GET /drafts/:id">()(await drafts(deps).get(ctx, params.id!));
    },
  },
  {
    method: "PUT",
    pattern: "/drafts/:id",
    wire: true,
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const { ifContentRevision: stated, ...patch } = await readBody<RequestOf<"PUT /drafts/:id">>(req);
      // The version the edit was made on: a draft moved off it refuses the edit (409 draft_changed).
      const ifContentRevision = readContentRevision(stated);
      const { draft, seq } = await drafts(deps).update(
        serviceContext(deps, req), params.id!, patch, ifContentRevision ? { ifContentRevision } : {},
      );
      return answer<"PUT /drafts/:id">()(draft, { status: 200, seq });
    },
  },
  {
    method: "DELETE",
    pattern: "/drafts/:id",
    wire: true,
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const { seq } = await drafts(deps).remove(serviceContext(deps, req), params.id!);
      return answerBuilt<"DELETE /drafts/:id">(new Response(null, { status: 204, headers: { "X-Sync-Seq": String(seq) } }));
    },
  },
  {
    method: "DELETE",
    pattern: "/drafts/:id/conditional",
    wire: true,
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const url = new URL(req.url);
      const ifContentRevision = readContentRevision(url.searchParams.get("ifContentRevision"));
      const stamp = url.searchParams.get("ifUpdatedAt");
      const ifUpdatedAt = stamp === null ? undefined : Date.parse(stamp);
      if (stamp !== null && (stamp.length > 40 || !Number.isFinite(ifUpdatedAt))) {
        throw new ServiceError("validation_failed", 400, "ifUpdatedAt must be a draft timestamp");
      }
      if (ifContentRevision === undefined && ifUpdatedAt === undefined) {
        throw new ServiceError("validation_failed", 400, "conditional discard requires a draft revision or timestamp");
      }
      const headers = new Headers();
      try {
        const { seq } = await drafts(deps).remove(serviceContext(deps, req), params.id!, { ifContentRevision, ifUpdatedAt });
        headers.set("X-Sync-Seq", String(seq));
      } catch (err) {
        // Already gone is a successful retry. A 404 on this path means the route is unsupported.
        if (!(err instanceof ServiceError) || err.code !== "not_found") throw err;
      }
      return answerBuilt<"DELETE /drafts/:id/conditional">(new Response(null, { status: 204, headers }));
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
    wire: true,
    relay: true,
    cost: "work",
    replay: "guarded",
    handler: async (req, deps, params) => {
      const body = await readBody<UntrustedBody<RequestOf<"POST /drafts/:id/resolve">>>(req);
      const { ifUpdatedAt } = body;
      if (ifUpdatedAt !== undefined && (typeof ifUpdatedAt !== "string" || !Number.isFinite(Date.parse(ifUpdatedAt)))) {
        throw new ServiceError("validation_failed", 400, "ifUpdatedAt must be a draft timestamp");
      }
      const { draft, seq } = await drafts(deps).resolve(
        serviceContext(deps, req), params.id!, body.outcome as SendResolution, ifUpdatedAt,
      );
      return answer<"POST /drafts/:id/resolve">()(draft, { status: 200, seq });
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
    wire: true,
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const body = await readBody<UntrustedBody<RequestOf<"POST /drafts/:id/schedule">>>(req);
      const { draft, seq } = await schedules(deps).schedule(
        serviceContext(deps, req), params.id!, body.sendAt, undefined, readContentRevision(body.ifContentRevision),
      );
      return answer<"POST /drafts/:id/schedule">()(draft, { status: 200, seq });
    },
  },
  {
    // SEND LATER: take the appointment off. Race-safe against the worker's claim — the service
    // answers 409 "already being sent" when the claim won, never a false "cancelled"; a repeat
    // cancel of an already-plain draft is idempotent success (the asked-for state).
    method: "DELETE",
    pattern: "/drafts/:id/schedule",
    wire: true,
    relay: true,
    cost: "work",
    replay: "state",
    handler: async (req, deps, params) => {
      const { draft, seq } = await schedules(deps).cancel(serviceContext(deps, req), params.id!);
      return answer<"DELETE /drafts/:id/schedule">()(draft, { status: 200, seq });
    },
  },
  {
    /**
     * WHAT HAPPENED UNDER THIS KEY — asked BEFORE a staged retry re-uploads anything, so a storage
     * refusal cannot throw away the only handle on a message that may already have gone. A READ:
     * it writes nothing, reserves nothing and cannot send, which is why it is a route and not a
     * flag on the send — a server predating a flag would have sent the message without its files,
     * and one predating this answers 404. The key is the `Idempotency-Key` header; 400 without.
     */
    method: "GET",
    pattern: "/drafts/:id/send-attempt",
    wire: true,
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const key = sendKeyOf(req);
      const firstSend = await sends(deps).attemptUnderKey(serviceContext(deps, req), params.id!, key);
      /* `found` is the answer and `firstSend` rides only with it: absent means "nothing has been
         sent under this key", which is the one reading that licenses staging and sending. */
      return answer<"GET /drafts/:id/send-attempt">()(firstSend ? { found: true, firstSend } : { found: false });
    },
  },
  {
    /**
     * CANCEL ASKS THE SERVER — `{ outcome, firstSend? }` for the `Idempotency-Key` header's send. A
     * key nobody reserved is tombstoned, so no window can send it later; a reserved one answers
     * what its row says. `connection`: its stale arm verifies by Sent, the send's own dial; it
     * never opens SMTP. Convergent, so a repeat answers the same. `draftId` is recorded only when
     * this account holds that draft. Relayed with the send, so a Cancel reaches the server it went to.
     */
    method: "POST",
    pattern: "/sends/withdraw",
    wire: true,
    relay: true,
    cost: "connection",
    replay: "state",
    handler: async (req, deps) => {
      const key = sendKeyOf(req);
      const body = (await readBody<UntrustedBody<RequestOf<"POST /sends/withdraw">> | null>(req)) ?? {};
      const draftId = body.draftId === undefined || body.draftId === null ? null : requireUuid(body.draftId, "draftId");
      const openSendAdapter = deps.services?.sendAdapter ?? ((mailboxId: string) => makeSendAdapter(deps, mailboxId));
      const withdrawn = await sends(deps).withdraw(serviceContext(deps, req), key, draftId, { openSendAdapter });
      return answer<"POST /sends/withdraw">()(withdrawn.firstSend ? { outcome: withdrawn.outcome, firstSend: withdrawn.firstSend } : { outcome: withdrawn.outcome });
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
    wire: true,
    relay: true,
    // `connection` rather than `paid`: it opens SMTP (and IMAP, to verify by Sent) on the
    // user's own server and debits nothing metered. Sending mail from an address nobody has
    // proven belongs to the sender is also a deliverability-reputation liability, not only a
    // cost one.
    cost: "connection",
    // The reservation answers every replay of a key.
    options: { replaySafe: true },
    handler: async (req, deps, params) => {
      const key = sendKeyOf(req);
      // Attachment bytes ride here — decoded to raw and handed to the service, never persisted. An
      // ordinary send carries no body, so `readBody` answers `{}` and this is `undefined`.
      const body = await readBody<RequestOf<"POST /drafts/:id/send">>(req);
      const attachments = decodeSendAttachments(body.attachments);
      const stagedAttachmentIds = readStagedIds(body.stagedAttachmentIds);
      const forwardOf = typeof body.forwardOf === "string" && body.forwardOf.length > 0 ? body.forwardOf : undefined;
      const again = body.again === true;
      if (again && (stagedAttachmentIds !== undefined || forwardOf !== undefined || body.forwardParts !== undefined)) {
        throw new ServiceError("validation_failed", 400, "again carries no staged files and no forward fields");
      }
      // A held forward names its original on the row: its confirmation and clock ride without `forwardOf`.
      const forwarding = forwardOf !== undefined || again;
      const forwardConfirmed = forwarding && body.forwardConfirmed === true;
      const forwardParts = readForwardParts(body.forwardParts, forwardOf);
      // The sender's clock for the quoted date. A malformed one never refuses a send: the date
      // then reads in UTC and English, as for a client that states none.
      const forwardZone = forwarding ? unlessMalformed(() => parseReaderZone(body.forwardZone, "forwardZone")) : undefined;
      const forwardLocale = forwarding ? unlessMalformed(() => parseReaderLocale(body.forwardLocale, "forwardLocale")) : undefined;
      // THE ROW THIS PRESS SAW. Threaded to `SendService.reserve`, which compares it against the
      // row it locks — see `SendInput.ifContentRevision`.
      const ifContentRevision = readContentRevision(body.ifContentRevision);
      const result = await sends(deps).send(
        serviceContext(deps, req), params.id!, key, sendDepsOf(deps),
        { attachments, stagedAttachmentIds, forwardOf,
          ...(forwardConfirmed ? { forwardConfirmed } : {}),
          ...(forwardParts ? { forwardParts } : {}),
          ...(forwardZone ? { forwardZone } : {}),
          ...(forwardLocale ? { forwardLocale } : {}),
          ...(ifContentRevision ? { ifContentRevision } : {}),
          ...(again ? { again: true } : {}) },
      );
      switch (result.status) {
        case "sent":
          // `firstSend` RIDES WHEN THE SERVICE STATES IT, and only then: it means this key was
          // already settled and this request delivered nothing. The reservation names the draft
          // that went, even when the request named a different one.
          return answer<"POST /drafts/:id/send">()(
            {
              status: "sent", providerMessageId: result.providerMessageId, sentDraftId: result.draftId,
              ...(result.sentDraftThrough === undefined ? {} : { sentDraftThrough: result.sentDraftThrough }),
              ...(result.firstSend ? { firstSend: result.firstSend } : {}),
              ...(result.sentCopy ? { sentCopy: result.sentCopy } : {}),
              ...(result.sentCopyReason ? { sentCopyReason: result.sentCopyReason } : {}),
              ...(result.sentCopyUntil ? { sentCopyUntil: result.sentCopyUntil } : {}),
            },
            { status: 200, seq: result.seq ?? undefined },
          );
        case "unverified":
          return answer<"POST /drafts/:id/send">()(
            {
              status: "unverified",
              message: "We couldn't confirm this send. Check your Sent folder before retrying.",
            },
            { status: 200, seq: result.seq ?? undefined },
          );
        case "failed":
          return answer<"POST /drafts/:id/send">()(
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
          return answer<"POST /drafts/:id/send">()(
            {
              status: "queued",
              message: "This send was accepted and is still being handed to your mail server.",
            },
            { status: 202, seq: result.seq ?? undefined },
          );
        default:
          return answer<"POST /drafts/:id/send">()(
            { status: "in_flight", message: "A send for this draft is already in progress." },
            { status: 409 },
          );
      }
    },
  },
];
