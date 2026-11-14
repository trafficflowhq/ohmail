/**
 * A LETTER BEING WRITTEN: the stored draft as the server answers it, the engine's row of it, the
 * files a send carries, and a received letter's attachment as listed.
 */
import type { EmailAddress, ISODateTime } from "./base.js";

export type DraftStatus = "draft" | "scheduled" | "sending" | "sent" | "unverified";

export interface DraftDTO {
  id: string;
  mailboxId: string;
  threadId: string | null;
  inReplyToMessageId: string | null;
  /** The message this draft forwards, exclusive with {@link inReplyToMessageId}. */
  forwardOfMessageId: string | null;
  /**
   * The original's attachment ids the person kept (sorted), only beside {@link forwardOfMessageId};
   * `null`: nothing was removed, every part goes. Absent from a server that predates it.
   */
  forwardParts: string[] | null;
  subject: string;
  /**
   * The text/plain body, authoritative for a plain draft.
   *
   * When {@link html} is set this is the alternative DERIVED from it on the server rather than
   * anything a client supplied — see `outbound-html.ts`. A `multipart/alternative` is a promise
   * that its two parts say the same thing, and deriving one from the other makes that structural.
   *
   * `null` on ONE path: a bounded page will not carry a stored body past `DRAFT_BODY_MAX_BYTES`,
   * and {@link bodyOmitted} says so. Never truncated, and never on a single-row read.
   */
  body: string | null;
  /**
   * Why {@link body} is `null` — present exactly when it is, absent otherwise. A reader that
   * knows only "no body" cannot tell a page that omitted it from a server that never sends one,
   * so the pairing is held in both directions by a test beside the snapshot writer.
   *
   * `over_ceiling` is a stored body past `DRAFT_BODY_MAX_BYTES`; `sent` is a draft already gone,
   * whose text the mirror need not hold; `over_page_budget` is a whole ROW too heavy for the
   * transport, which takes {@link html} and {@link rationale} with it so the row can still be
   * listed. `GET /drafts/:id` is how any of them is opened.
   */
  bodyOmitted?: "over_ceiling" | "sent" | "over_page_budget";
  /** The rich body, sanitized. `null` for a plain-text draft — the ordinary case. */
  html: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  /**
   * Blind-carbon recipients. Echoed back so a client can confirm the server ACCEPTED them — a new
   * client sending `bcc` to a server that predates it gets a DTO with no `bcc` key and can refuse
   * to send rather than deliver silently without the copies. Never leaves the envelope on the wire:
   * the delivered message and the Sent copy carry no Bcc header (see `SendService`).
   */
  bcc: EmailAddress[];
  rationale: string | null;
  status: DraftStatus;
  /**
   * WHEN this draft is scheduled to be sent (mail 0077) — non-null exactly while `status` is
   * `scheduled` (it also survives, invisibly to clients, through the worker's claim window as
   * the crash-recovery predicate). A client renders it in the reader's own local time; the
   * value is the instant the user picked, with timezone.
   */
  sendAt: ISODateTime | null;
  /**
   * The failure sentence from a scheduled send that could not be kept — the mailbox was
   * disconnected by send time, and so on. Server words, rendered as a quotation (the same
   * treatment `SendState.reason` gives a live refusal); cleared by the next edit or schedule.
   */
  sendError: string | null;
  /**
   * How many files a scheduled send carries, kept on this computer until it goes (mail 0179).
   * While `status` is `scheduled` they are waiting; on a plain draft they were not kept and must be
   * attached again. Absent when there are none, which is every server's row.
   */
  sendFiles?: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /**
   * WHICH VERSION OF THIS DRAFT THIS IS — an opaque server-minted digest of the row's sendable
   * content. A client carries the one it last saw back on the send (`ifContentRevision`); a send
   * naming a revision the row has moved off is refused, `draft_changed`, and nothing goes. Not
   * `updatedAt`: that moves when a second window writes an identical buffer back, and refusing a
   * send over a change nobody can see is a false alarm. Opaque — never parsed, never recomputed
   * client-side (`draftContentRevision` is the one implementation).
   */
  contentRevision: string;
}

/**
 * One file the compose form is sending — bytes, nothing kept. It rides the
 * `mail_send` mutation and the send request (`POST /drafts/:id/send`),
 * base64; no `attachments` row, no `drafts` column. The compose surface
 * states the total-size limit up front — the smaller of what the surface
 * can carry and what the sending mailbox's submission server announced.
 * A client permitted to stage (`HttpAdapterOptions.stageAttachments`) puts
 * oversized bytes in object storage on a signed URL (at rest at most 24 h)
 * and sends references; every other client puts them in the request.
 */
export interface ComposeAttachment {
  filename: string;
  contentType: string;
  /** base64-encoded bytes. */
  contentBase64: string;
}

export interface EngineDraft {
  id: string;
  mailboxId: string;
  threadId: string | null;
  inReplyToMessageId: string | null;
  /** The message this draft forwards. Absent from an older server, read as none. */
  forwardOfMessageId?: string | null;
  /** The original's files the person kept, beside a forward; `null` or absent: every file. */
  forwardParts?: string[] | null;
  subject: string;
  /**
   * The draft's plain text, or `null` when THIS MIRROR DOES NOT HOLD IT.
   *
   * Two states, named rather than collapsed: a string — empty included — is the text of record,
   * and `null` is a row that arrived without one. `/sync` changes carry whole DTOs, so `null` is
   * reachable only from a bounded page that omits the field; the type is nullable so no reader
   * can seed an editor from a body nobody sent. {@link draftBodyKnown} is the one predicate.
   */
  body: string | null;
  /**
   * Why {@link body} is `null`, when the page that dropped it said so. `over_ceiling` is a stored
   * body past `DRAFT_BODY_MAX_BYTES`; `sent` is a draft already gone, whose text this mirror does
   * not hold (`html` goes with it) and which `readDraftBody` fetches; `over_page_budget` is a
   * whole row too heavy for the transport that carries the page, `html` and `rationale` withheld.
   *
   * Optional, and it changes NO decision: {@link draftBodyKnown} is the one predicate, and a body
   * is unknown whether or not a reason arrived — an older server sends none, a newer one may send
   * a reason this build has never heard of.
   */
  bodyOmitted?: "over_ceiling" | "sent" | "over_page_budget";
  /** The stored markup; `null` plain or not carried; absent from an overlay before its echo. */
  html?: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  /** Blind-carbon recipients. Delivered on the envelope only; never a header on the sent mail. */
  bcc: EmailAddress[];
  rationale: string | null;
  status: "draft" | "scheduled" | "sending" | "sent" | "unverified";
  /**
   * WHEN a `scheduled` draft will be sent (Send later, mail 0077) — the instant the user
   * picked, rendered in the reader's own local time. Optional because an older server sends no
   * key at all, and a mirror row predating the field reads as "no appointment".
   */
  sendAt?: ISODateTime | null;
  /**
   * The failure sentence from a scheduled send that could not be kept — server words, rendered
   * as a quotation (`SendState.reason`'s treatment). Cleared by the next edit or schedule.
   */
  sendError?: string | null;
  /**
   * The files a scheduled send keeps on this computer (mail 0179): waiting while `scheduled`, not
   * kept once the row is a plain draft again. Absent: none.
   */
  sendFiles?: number;
  /** Client-local: the user took the AI draft into the editor. */
  accepted?: boolean;
  /** The server's version of the row's words; absent from an older server or an overlay. */
  contentRevision?: string;
  /**
   * Client-local, never on a server row or the wire: the Idempotency-Key of the `draft_save` create
   * that painted this row and has not settled. Its id is local until then; a door binds the key.
   */
  pendingCreate?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
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
