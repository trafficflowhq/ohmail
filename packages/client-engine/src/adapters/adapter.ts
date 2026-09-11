import type { ServerAddressOpts, ServerAddressWire, ServerSearchOpts, ServerSearchWire } from "../engine.js";
import type {
  EngineMutation, MessageBodyBatchWire, MessageBodyWire, SyncChange, SyncResponse, UnsubscribeResult,
} from "../types.js";

/**
 * ONE interface, two implementations (FixturesAdapter for ?demo/UI tests,
 * HttpAdapter for the real wire). The Engine is adapter-agnostic — swapping
 * Stage-2 live sync in is a construction-time config change, not a rewrite.
 */

export interface SyncParams {
  /** The cursor of record ("0" ⇒ bootstrap). */
  since: string;
  limit?: number;
  /** Optional `?types=` filter (contract §3.1). */
  types?: string[];
}

export interface MutationOutcome {
  /**
   * Authoritative changes to apply to the mirror right away (the §3.4
   * read-your-writes echo). Empty ⇒ the endpoint returned no seq'd DTO —
   * the engine reconciles via the next /sync drain instead.
   */
  changes: SyncChange[];
  /** The X-Sync-Seq of the mutation (null when the endpoint does not echo one). */
  seq: number | null;
  /**
   * The server's own id for a row this mutation created, when the caller
   * must keep using it. Absent for mutations on something already named and
   * for creations whose id the caller never needs again (`tag_create` mints
   * a client-local overlay id; the server's row arrives in {@link changes}).
   * `draft_save` is the real exception: an autosaving compose must keep
   * PATCHing the same row and then send that row — one draft from first
   * keystroke to delivery. Without the id here the surface would hunt the
   * mirror for a lookalike row, the matching that sends the wrong message.
   */
  entityId?: string;
  /**
   * The delivered Message-ID of a send the server confirmed sent — present
   * only on `mail_send` with status `sent` (never unverified/failed/
   * in_flight). It is the header the server minted and appended to the Sent
   * folder, so it is the exact `messageIdHeader` the real Sent copy carries
   * when the worker ingests it later. That identity lets the engine drop its
   * optimistic Sent overlay the moment a drain delivers the real row instead
   * of leaving a fabricated twin. Absent ⇒ no Sent overlay is materialised,
   * which is the FixturesAdapter's answer (the demo mints no ids).
   */
  providerMessageId?: string | null;
  /**
   * The decision was accepted for somebody else to carry out — who, by
   * name. Only `screener_decide` carries it, and only where the mailbox is
   * organized by another install: the server records the decision, answers
   * 202, nothing moved and no rule was written — this is NOT a confirmation
   * the decision took effect. It travels back because a queued decision
   * emits no `change_log` row, so this is the only evidence the press
   * happened. `name` is `null` where the holder is real but unnamed — the
   * three-state shape every holder sentence renders.
   */
  pendingWith?: { name: string | null } | null;
}

/**
 * One attachment's metadata as the server sends it
 * (`GET /messages/:id/attachments`). Deliberately the wire shape,
 * field-for-field — `contentType`, not the UI's `mimeType`; a nullable
 * `filename` — because the adapter reads the protocol and exactly one place
 * (`toAttachmentItem` in the engine) decides what the surface sees.
 * `inline` is a `cid:` part referenced by the HTML body (a logo, a signature
 * image), not something a user thinks of as a file; it arrives so the engine
 * can filter on it rather than guess.
 */
export interface AttachmentWire {
  id: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  inline: boolean;
  /**
   * The part's `Content-ID` (brackets already stripped server-side), or `null`/absent. It is
   * the join key between the html body's `cid:<contentId>` references and this part's bytes —
   * what lets the reader see an embedded signature logo IN the body instead of a blanked box.
   * OPTIONAL because absence is a real wire state, not a broken one: an older server that does
   * not send it degrades to the image staying blanked, exactly as it always was.
   */
  contentId?: string | null;
  messageId: string;
}

export interface EngineAdapter {
  /** Fetch one /sync page. Throws CursorExpiredError on a 410 (§3.2). */
  sync(params: SyncParams): Promise<SyncResponse>;
  /**
   * `POST /sync/pull` — ring the worker's doorbell
   * (`mailboxes.sync_requested_at`) so the next IMAP scan happens now: a
   * drain shows what the worker already has, and the user is asking about
   * mail it has not seen. The gesture rings this, then drains; arrivals use
   * the ordinary wake channel. `requestedAt` is the honest-settle baseline:
   * a mailbox whose `lastSyncAt` moves past it has been scanned since the
   * pull. Optional — the FixturesAdapter must issue zero requests, and
   * callers read absence as "no doorbell here".
   */
  requestPull?(): Promise<{
    requested: number;
    requestedAt: string;
    /**
     * Each mailbox's OWN effective request instant, at the DATABASE's clock — the honest-settle
     * baseline. A mailbox holding a young standing request answers with THAT stamp, not with
     * this call's, so a settle that compares per mailbox never waits on a bar an already-owed
     * visit could not have aimed at.
     */
    mailboxes: Array<{ id: string; requestedAt: string }>;
  }>;
  /**
   * Execute a mutation. `idempotencyKey` is stable across retries of the SAME
   * logical intent (contract §1.6) — a replay must not double-apply.
   * Throws MutationRejectedError (retryable or not) on failure.
   */
  mutate(m: EngineMutation, opts: { idempotencyKey: string }): Promise<MutationOutcome>;
  /**
   * Fetch one message's body text, or `null` when this adapter serves no
   * bodies at all. `null` is the FixturesAdapter's answer and not a stub:
   * demo rows carry `body` in the mirror already, and the engine writes no
   * record for a `null`, keeping `?demo=1` at exactly zero requests
   * (`demo-zero-network.test.ts` asserts it). It sits on the adapter because
   * there are four surfaces and one protocol. A rejection MUST throw rather
   * than resolve empty — the engine turns a throw into a `failed` record;
   * resolving `{text: ""}` on a 500 would render an empty message as mail.
   */
  fetchBody(messageId: string): Promise<MessageBodyWire | null>;

  /**
   * `GET /drafts/:id` — THE DRAFT'S TEXT, when the mirror row arrived without it.
   *
   * OPTIONAL for the reason `fetchBodies` is: absence is a real answer. The FixturesAdapter's
   * rows always carry a body, so the demo keeps not having this and the compose surface never
   * asks. `null` means the server answered and named no text; a refusal THROWS, because
   * "unknown" and "empty" are the two states the caller has to tell apart — see
   * `EngineDraft.body`.
   */
  fetchDraftBody?(draftId: string): Promise<string | null>;

  /**
   * Fetch one message's body text, or `null` when this adapter serves no
   * bodies at all. `null` is the FixturesAdapter's answer, not a stub: demo
   * rows carry `body` in the mirror, and the engine writes no record for a
   * `null`, keeping `?demo=1` at zero requests
   * (`demo-zero-network.test.ts`). On the adapter because there are four
   * surfaces and one protocol. A rejection MUST throw, never resolve empty:
   * the engine turns a throw into a `failed` record; `{text: ""}` on a 500
   * would render an empty message as though that were the mail.
   */
  fetchBodies?(messageIds: string[]): Promise<MessageBodyBatchWire[] | null>;

  /**
   * `GET /search` — the full-corpus archive, or absent when this client has no archive
   * (fixtures, desktop).
   *
   * Optional on purpose: absence is what lets the surface say "this client cannot reach the
   * archive" instead of claiming an empty one. Resolving `null` means the same thing;
   * resolving `{items: []}` means the archive answered and matched nothing, and the two must
   * never be conflated — one is a missing capability, the other is a real result.
   */
  searchServer?(query: string, opts: ServerSearchOpts): Promise<ServerSearchWire | null>;

  /**
   * `GET /messages/bodies?ids=…` — every body a thread needs in one request
   * (a thread of eight once issued eight calls through a four-wide
   * limiter). Optional: the FixturesAdapter issues zero requests, and
   * {@link OhmailEngine.hydrateThread} falls back to asking per message.
   * Rows come back keyed by `messageId` in any order; an unowned id is
   * simply absent (not `null`, not an error), and the per-message fallback
   * makes an older server merely slower. A rejection throws, and the engine
   * fails every id in the batch.
   */
  searchAddressServer?(address: string, opts: ServerAddressOpts): Promise<ServerAddressWire | null>;

  /**
   * `POST /messages/:id/unsubscribe` — RFC 8058 one-click, performed SERVER-SIDE (the reader's
   * IP and reading time never reach the sender). Optional for the reason `searchServer` is:
   * absence is a real answer. The FixturesAdapter has no server and must issue zero requests
   * — the demo is self-contained — so it keeps NOT having this, and a surface reads its absence
   * as "this client
   * cannot unsubscribe" — offering no control rather than a dead one. A refusal THROWS (carrying
   * the server's sentence); a 2xx resolves the outcome. The URL is never a parameter — the server
   * reads it from the message's stored headers, which is what keeps this off the SSRF surface.
   */
  unsubscribe?(messageId: string): Promise<UnsubscribeResult>;

  // ── attachments ──────────────────────────────────────────────────────────
  //
  // ohmail stores no attachment bytes: metadata is synced at ingest; the
  // bytes are fetched from the user's own IMAP mailbox when asked for, held
  // for the session, never written anywhere. Hence three methods and not a
  // field on MessageDTO — `listAttachments` is a cheap row read, the two
  // byte methods each open a real IMAP connection. All three are optional:
  // absence is a real answer (the FixturesAdapter must issue zero requests),
  // and the surface reads absence as "this client cannot open attachments"
  // instead of rendering a control that cannot work.

  /**
   * `GET /messages/:id/attachments` — metadata for one message, WITHOUT fetching any bytes.
   *
   * This is the call the strip renders from: filenames, types and sizes for every part, at the
   * cost of one indexed row read and no IMAP connection at all. Nothing here touches the mail
   * server, which is what makes it safe to issue on opening a message.
   */
  listAttachments?(messageId: string): Promise<AttachmentWire[]>;

  /**
   * `GET /attachments/:id` — ONE attachment's bytes, fetched live from IMAP.
   *
   * Returns a Blob so the browser can render or save it directly. A non-2xx THROWS, carrying the
   * server's own sentence, for the same reason `fetchBody` does: resolving an empty Blob on a
   * refusal would render a blank image where an explanation belongs. A 413 (`payload_too_large`)
   * is the size ceiling and is distinguishable by the rejection's `code`.
   */
  fetchAttachment?(attachmentId: string): Promise<Blob>;

  /**
   * `POST /messages/:id/attachments/download-all` — every non-inline attachment on one message,
   * as a zip assembled server-side from IMAP.
   *
   * One request and one IMAP connection for the whole set, rather than N of each — which is the
   * only reason this exists as its own method instead of the surface looping `fetchAttachment`.
   * A part that cannot be fetched is skipped and named in the archive's `_errors.txt` rather than
   * failing the download, so a 200 here does NOT promise every file is present.
   */
  fetchAllAttachments?(messageId: string): Promise<Blob>;
}
