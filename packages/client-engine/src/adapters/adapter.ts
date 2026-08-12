import type { ServerSearchOpts, ServerSearchWire } from "../engine.js";
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
   * THE SERVER'S OWN ID FOR A ROW THIS MUTATION CREATED, when the caller has to keep using it.
   *
   * Absent for every mutation that acts on something already named — which is nearly all of them —
   * and for a creation whose id the caller never needs again: `tag_create` mints a client-local id
   * for its overlay, the server's row arrives in {@link changes}, the two never coexist, and
   * nothing asks which is which afterwards.
   *
   * `draft_save` is the exception, and it is a real one rather than a convenience. A compose that
   * autosaves must go on PATCHing THE SAME ROW, and must then SEND that row — one draft from first
   * keystroke to delivery. Without the id here the surface would have to invent one and hope, or
   * hunt the mirror for a row that looks like what it just wrote, which is the sort of matching
   * that eventually sends the wrong message.
   */
  entityId?: string;
  /**
   * THE DELIVERED MESSAGE-ID of a send the server CONFIRMED sent, and present ONLY then.
   *
   * `mail_send` alone carries it — `POST /drafts/:id/send` answers `{status:"sent",
   * providerMessageId}` — and only on the `sent` status, never `unverified`/`failed`/`in_flight`.
   * It is the Message-ID header the server minted up front and appended to the Sent folder, so it
   * is the exact `messageIdHeader` the real Sent copy will carry when the worker's Sent-folder watch
   * ingests it minutes later. That identity is what lets the engine reconcile its optimistic Sent
   * overlay against the real row and drop the overlay the moment a drain delivers it, rather than
   * leaving a fabricated twin behind. Absent ⇒ the engine materialises no Sent overlay, which is
   * exactly the FixturesAdapter's answer (the demo has no server to mint an id).
   */
  providerMessageId?: string | null;
}

/**
 * One attachment's METADATA as the server sends it (`GET /messages/:id/attachments`).
 *
 * Deliberately the wire shape, field-for-field, including `contentType` rather than the UI's
 * `mimeType` and a nullable `filename`: the adapter's job is to read the protocol, and exactly one
 * place — `toAttachmentItem` in the engine — decides what the surface sees. Renaming here would
 * put that decision in two files and let them drift.
 *
 * `inline` is a `cid:` part referenced by the HTML body (a newsletter's logo, a signature image),
 * NOT something a user thinks of as a file. It arrives so the engine can filter on it rather than
 * guess.
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
   * Execute a mutation. `idempotencyKey` is stable across retries of the SAME
   * logical intent (contract §1.6) — a replay must not double-apply.
   * Throws MutationRejectedError (retryable or not) on failure.
   */
  mutate(m: EngineMutation, opts: { idempotencyKey: string }): Promise<MutationOutcome>;
  /**
   * Fetch one message's body text, or `null` when this adapter serves no
   * bodies at all.
   *
   * `null` is the FixturesAdapter's answer and it is not a stub: the demo world's message
   * rows carry `body` in the mirror already, so there is nothing to fetch and nothing that
   * may touch the network — the demo is self-contained. The engine writes no record for a
   * `null`, which
   * keeps `?demo=1` at exactly zero requests — `demo-zero-network.test.ts` asserts it.
   *
   * It is on the ADAPTER rather than beside the surfaces because there are four surfaces
   * and one protocol. `GET /messages/:id/body` existed, spend-gated and contract-tested,
   * with zero callers for the whole of Stage 2; the reason every pile rendered a one-line
   * snippet was that nothing in the client had ever asked.
   *
   * A rejection MUST throw rather than resolve empty — the engine turns a throw into a
   * `failed` record and the surface says so. Resolving `{text: ""}` on a 500 would render
   * an empty message as though that were the mail.
   */
  fetchBody(messageId: string): Promise<MessageBodyWire | null>;

  /**
   * `GET /messages/bodies?ids=…` — EVERY body a thread needs, in ONE request.
   *
   * Opening a conversation asks for the opened message and each of its siblings, and until this
   * existed that was N calls issued from one effect: a thread of eight opened eight requests
   * through a four-wide limiter, so the last two siblings waited for a whole round trip before
   * their fetch even started, and the reader watched the stack fill in in visible steps.
   *
   * OPTIONAL, for the reason `searchServer` and `listMessages` are: absence is a real answer, not
   * a broken adapter. The FixturesAdapter has no server — the demo is self-contained and must
   * issue zero requests — so it keeps NOT having this, and {@link OhmailEngine.hydrateThread}
   * falls back to asking per message rather than pretending the capability is there.
   *
   * ── WHAT IT MAY AND MAY NOT ANSWER ────────────────────────────────────────────────────────
   *
   * Rows come back keyed by `messageId` and in ANY order. An id the server does not own is simply
   * absent — not `null`, not an error — so the caller matches on the id and falls back per message
   * for anything unanswered. That fallback is what makes a server which ignores the parameter
   * (an older deploy) merely slower rather than a thread of empty messages.
   *
   * A rejection THROWS, exactly as `fetchBody` does, and the engine turns it into a `failed`
   * record for every id in the batch — the same state each of them would have reached alone.
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
  // ohmail STORES NO ATTACHMENT BYTES. Metadata is synced at ingest and lives server-side; the
  // bytes are fetched from the user's own IMAP mailbox at the moment they are asked for, held for
  // the session, and never written anywhere. That is why this is three methods and not a field on
  // MessageDTO: `listAttachments` is a cheap row read, and the two byte methods each open a real
  // IMAP connection to the user's mail server.
  //
  // ALL THREE ARE OPTIONAL, for the reason `searchServer` is: absence is a real answer. The
  // FixturesAdapter has no server to fetch from, and a `?demo=1` tab must issue zero requests
  // — the demo is self-contained — so it must keep NOT having these, and the surface reads
  // their absence as
  // "this client cannot open attachments" instead of rendering a control that cannot work.

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
