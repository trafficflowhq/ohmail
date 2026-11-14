/**
 * THE CALLS: every request a client makes of a server that both sides take their types from.
 *
 * {@link Routes} is keyed `"METHOD /pattern"`, in the server's own spelling of the route. An entry
 * says what the path names (`params`), what the request carries (`body`, `never` for none) and
 * what a 2xx answers (`answer`). The server's handler answers through it and the client calls
 * through it, so a field renamed on one side only does not compile on the other.
 *
 * AN ENTRY EXISTS ONLY WHEN BOTH SIDES ARE BOUND, in the same change. A route some client calls
 * with its own types, not yet from here, is named in {@link UnboundCall}. The two together are
 * {@link ClientCall}: every route a client of this tree is known to call. A route in neither is
 * the server's alone, and the server lists those with a reason each.
 */
import type { AuthVerdict, ISODateTime, Page, UnsubscribeHeaderState } from "./base.js";
import type { HelloAnswer } from "./client.js";
import type { FetchingDTO } from "./mailboxes.js";
import type { SnapshotResponse, SyncResponse } from "./records.js";
import type { MessageDTO, MessageStateDTO, TrashRowDTO } from "./mail.js";
import type { MessageBodyBatchItem, MessageBodyDTO } from "./bodies.js";
import type { FolderDTO, RuleDTO, RuleKeyAddress, TagDTO } from "./organizing.js";
import type { ScreenerItem } from "./screener.js";
import type {
  AutoFiledItemWire, AutoFiledUndoWire, HeldReleaseGroupWire, HeldReleaseSenderWire, ScreenDecisionResult,
  ScreenerPendingDecision, ScreenRequestResult, StayedWire, UnscreenedGroupWire, UnscreenedPileWire, WaitingRequestWire,
} from "./screener-answers.js";
import type { AddressSearchResult, SearchResult } from "./search.js";
import type { AttachmentWire, DraftDTO } from "./drafts.js";
import type { QueuedAnswer, RuleQueuedAnswer, RuleTravel, WithdrawSendOutcome } from "./act-answers.js";
import type { UnboundCall } from "./unbound-calls.js";
import type {
  CreateDraftBody, CreateRuleBody, FolderCreateBody, FolderRenameBody, MarkSeenBody, MessagePatchBody, MoveBody,
  PatchDraftBody, PatchRuleBody, ScreenBody, SendResolution, TagAssignBody, TagBody, TriageWireBody,
} from "./requests.js";

/** No path parameter. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type None = {};
/** The one path parameter nearly every route has. */
type Id = { id: string };

/**
 * A 2xx answered with bytes and not JSON: a file, a zip. The server builds that response itself;
 * a client reads it as a blob.
 */
export type Bytes = ArrayBuffer;

/** One file of a send, carried in the request: base64, nothing kept. */
export interface SendAttachmentWire { filename?: string; contentType?: string; contentBase64?: string }

/**
 * The send request's body — everything the delivery needs beyond the stored draft, nothing kept.
 * Two attachment shapes, both live: `attachments` carries bytes as base64 — the browser stages
 * only above the inline ceiling and the desktop app never stages, so nearly every send is this
 * shape; removing it would first require both clients to stage unconditionally.
 * `stagedAttachmentIds` names upload tickets already in object storage — the transport that lifts
 * the serverless body limit. Either or both; the service concatenates (inline first) and applies
 * one cap whose surface term depends on the shapes present (`sendSurfaceFor`). Neither is
 * persisted — `ifContentRevision`, the draft version this press saw, included.
 */
export interface SendRequestBody {
  attachments?: SendAttachmentWire[];
  /** Upload-ticket ids. Account-scoped in the service; a foreign id is a 404. */
  stagedAttachmentIds?: string[];
  /** Forward this original — the server reads it, refuses an unconfirmed no_forward one, and quotes it. */
  forwardOf?: string;
  /** Which of the original's parts go (attachment ids), only beside `forwardOf`; absent: all of them. */
  forwardParts?: string[];
  /** The person confirmed forwarding a no_forward original after the ask. Only `true` counts. */
  forwardConfirmed?: boolean;
  /** The sender's IANA zone and language tag, for the date the quoted header gives the original. */
  forwardZone?: string;
  forwardLocale?: string;
  /**
   * WHICH VERSION OF THE DRAFT THIS PRESS WAS COMPOSED AGAINST — the `DraftDTO.contentRevision`
   * the client last saw. The send refuses a row that has moved off it (`draft_changed`, 409) and
   * delivers nothing. Absent is UNSTATED, which a client predating the field is: it sends as it
   * always did.
   */
  ifContentRevision?: string;
  /**
   * SEND THE HELD MESSAGE AGAIN under its own Message-ID, Sent checked first. Only `true` counts;
   * with staged files or a forward field it is refused, since the held row names its own original.
   */
  again?: boolean;
}

/**
 * `POST /drafts/:id/send` answers this shape at 200 AND at 409 — never the error envelope. Read
 * field by field by a client: a server may state fewer of them than this.
 */
export interface SendAnswer {
  status: "sent" | "unverified" | "failed" | "in_flight" | "queued";
  providerMessageId?: string | null;
  message?: string;
  /** The send this key already held: this press delivered nothing new. */
  firstSend?: { status: string; at: string };
  /** Where a delivered send's Sent copy stands, why it is not filed, and until when it is tried. */
  sentCopy?: "filed" | "pending" | "missing";
  sentCopyReason?: "too_big" | "full" | "refused" | "unreachable";
  sentCopyUntil?: string;
}

/** `POST /attachments/staging` — one upload ticket for one file of a send. */
export interface StagingMintBody {
  mailboxId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** What the bytes will be: 64 lowercase hex characters. A client with no SHA-256 to hand states none. */
  contentSha256?: string;
}

/** What a mint hands the browser: a ticket id and the exact way to put bytes at it. */
export interface StagedUploadGrantWire {
  /** The ticket id — what a later send references in place of the bytes. */
  id: string;
  uploadUrl: string;
  uploadMethod: string;
  /** Sent verbatim on the upload. Opaque: the storage wire is the server's business. */
  uploadHeaders: Record<string, string>;
  /** ISO-8601. When the staged bytes stop existing. */
  expiresAt: string;
}

/** One month of the History rail: how many letters, and its newest one, the jump target. */
export interface TimelineMonth {
  month: string;
  count: number;
  first: { date: string; id: string };
}

/** A letter's patch or move when the letter was touched here: the letter as it now stands. */
type Applied = MessageDTO;

export interface Routes {
  // ── who the server is ───────────────────────────────────────────────────────
  "GET /hello": { params: None; body: never; answer: HelloAnswer };

  // ── the feed ────────────────────────────────────────────────────────────────
  "GET /sync": { params: None; body: never; answer: SyncResponse };
  "GET /sync/snapshot": { params: None; body: never; answer: SnapshotResponse };
  /** Ring the worker's doorbell. `mailboxIds` narrows the ring; absent, every connected mailbox. */
  "POST /sync/pull": {
    params: None;
    body: { mailboxIds?: string[] };
    answer: {
      requested: number; requestedAt: ISODateTime; mailboxes: Array<{ id: string; requestedAt: ISODateTime }>;
      /** Is anything fetching now (`MailboxDTO.fetching`, once). `null`: this server does not say; absent: an older one. */
      fetching?: FetchingDTO | null;
    };
  };

  // ── letters ─────────────────────────────────────────────────────────────────
  /** One keyset page of a view. `view=trash` answers the deleted letters, each with its restore target. */
  "GET /messages": { params: None; body: never; answer: Page<MessageDTO> | Page<TrashRowDTO> };
  "GET /messages/timeline": {
    params: None; body: never;
    answer: { total: number; months: TimelineMonth[]; undated: number };
  };
  "GET /messages/bodies": { params: None; body: never; answer: Page<MessageBodyBatchItem> };
  "GET /messages/:id": { params: Id; body: never; answer: MessageDTO };
  "GET /messages/:id/body": { params: Id; body: never; answer: MessageBodyDTO };
  "PATCH /messages": { params: None; body: MarkSeenBody; answer: { items: MessageDTO[] } };
  /** 200: the letter. 202: the folder half became a request for the install that organizes the mailbox. */
  "PATCH /messages/:id": { params: Id; body: MessagePatchBody; answer: Applied | (QueuedAnswer & { dto: MessageDTO }) };
  "POST /messages/:id/move": { params: Id; body: MoveBody; answer: Applied | (QueuedAnswer & { dto: MessageDTO }) };
  /** 200 with `alreadyGone` for a letter the server no longer holds anywhere. */
  "DELETE /messages/:id": {
    params: Id; body: never;
    answer: Applied | (MessageDTO & { alreadyGone: true }) | (QueuedAnswer & { dto: MessageDTO });
  };
  "POST /messages/:id/restore": { params: Id; body: never; answer: { restoreTo: string; pending: boolean } };
  "POST /messages/:id/triage": { params: Id; body: TriageWireBody; answer: MessageStateDTO };
  "POST /messages/:id/tags": { params: Id; body: TagAssignBody; answer: { labels: string[]; tagId: string } };
  "POST /messages/:id/unsubscribe": {
    params: Id;
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    body: {};
    answer: {
      messageId: string; posted: boolean; status: number | null;
      refusal: string | null; header: UnsubscribeHeaderState;
      /** The sender check's verdict the server kept on this call. */
      authVerdict: AuthVerdict;
    };
  };
  "GET /messages/:id/attachments": { params: Id; body: never; answer: { items: AttachmentWire[] } };
  "POST /messages/:id/attachments/download-all": { params: Id; body: never; answer: Bytes };
  "GET /attachments/:id": { params: Id; body: never; answer: Bytes };
  "POST /attachments/staging": { params: None; body: StagingMintBody; answer: StagedUploadGrantWire };

  // ── search ──────────────────────────────────────────────────────────────────
  /** Two arms on one route: the text search, and with `address` the letters to or from one address. */
  "GET /search": {
    params: None; body: never;
    /** `answeredFrom`: a desktop engine's own door answered from its copy of the account, not from the account's server. */
    answer: (SearchResult | AddressSearchResult) & { answeredFrom?: "mirror" };
  };

  // ── the Screener ────────────────────────────────────────────────────────────
  "GET /screener": {
    params: None; body: never;
    answer: {
      items: ScreenerItem[]; nextCursor: string | null;
      /**
       * The set a control may offer to buy suggestions for: the page's senders that are held,
       * eligible and without a stored suggestion; how many one request will accept; and how many
       * this server recommends per request.
       */
      suggestable: { senders: string[]; maxPerRequest: number; recommendedPerRequest: number };
      /** Decisions this install made that their organizer has not applied yet; their senders are on no page. */
      pendingDecisions: ScreenerPendingDecision[];
      /** The queue's exact size, on the first page only. */
      total?: number;
      /** The mailboxes the queue leaves out, sorted; only when the caller asked with `live=1`. */
      gone?: string[];
      /**
       * Only from a desktop engine's own door of a Cloud account: its copy is still taking in the
       * account, so this page is ahead of the mail and rules it is read beside.
       */
      copyBehind?: true;
    };
  };
  /** 200 a decision applied, 202 a decision queued for the install that organizes the mailbox. */
  "POST /screener/:id": { params: Id; body: ScreenBody; answer: ScreenDecisionResult | ScreenRequestResult };
  "GET /screener/stayed": { params: None; body: never; answer: { stayed: StayedWire[]; max: number } };
  "GET /screener/auto-filed": {
    params: None; body: never; answer: { items: AutoFiledItemWire[]; more: boolean; max: number };
  };
  "POST /screener/auto-filed/undo": { params: None; body: { messageIds: string[] }; answer: AutoFiledUndoWire };
  "GET /screener/held-releases": {
    params: None; body: never;
    answer: {
      groups: HeldReleaseGroupWire[]; senders: HeldReleaseSenderWire[]; total: number; max: number;
      fingerprint: string; dismissed: boolean;
    };
  };
  "POST /screener/held-releases": {
    params: None;
    /** Absent `ruleIds` releases EVERY group; absent `senders` releases no contact-only sender. */
    body: { ruleIds?: string[]; senders?: string[] };
    answer: { released: HeldReleaseGroupWire[]; releasedSenders: HeldReleaseSenderWire[]; total: number };
  };
  "POST /screener/held-releases/dismiss": {
    params: None; body: { fingerprint: string }; answer: { dismissed: boolean };
  };
  "GET /screener/unscreened": {
    params: None; body: never;
    answer: {
      groups: UnscreenedGroupWire[]; total: number; complete: boolean; max: number; pile?: UnscreenedPileWire;
    };
  };
  "POST /screener/unscreened": {
    params: None;
    /** Absent `addresses` screens EVERY group shown. */
    body: { addresses?: string[]; pile?: UnscreenedPileWire };
    answer: { screened: UnscreenedGroupWire[]; total: number };
  };

  // ── tags and folders ────────────────────────────────────────────────────────
  "POST /tags": { params: None; body: TagBody; answer: TagDTO };
  "PATCH /tags/:id": { params: Id; body: Partial<TagBody>; answer: TagDTO };
  "DELETE /tags/:id": { params: Id; body: never; answer: null };
  "POST /folders": { params: None; body: FolderCreateBody; answer: FolderDTO };
  "PATCH /folders/:id": { params: Id; body: FolderRenameBody; answer: FolderDTO };
  "DELETE /folders/:id": { params: Id; body: never; answer: FolderDTO };
  /** Dismiss a failed command. A failed create takes its never-created row with it: `{ dismissed: true }`. */
  "DELETE /folders/:id/op": { params: Id; body: never; answer: FolderDTO | { dismissed: true } };

  // ── rules ───────────────────────────────────────────────────────────────────
  /** 201 a new rule, 200 the rule already under this key, 202 a rule asked for and not written here. */
  "POST /rules": { params: None; body: CreateRuleBody; answer: RuleDTO | (RuleDTO & { travel: RuleTravel }) | RuleQueuedAnswer };
  "PATCH /rules/:id": { params: Id; body: PatchRuleBody; answer: RuleDTO | (RuleDTO & { travel: RuleTravel }) | RuleQueuedAnswer };
  /** 204 a rule gone; 202 a delete asked for. The body names a published rule's key, at its address only. */
  "DELETE /rules/:id": { params: Id; body: { key: RuleKeyAddress }; answer: null | RuleQueuedAnswer };

  // ── drafts and sending ──────────────────────────────────────────────────────
  "POST /drafts": { params: None; body: CreateDraftBody; answer: DraftDTO };
  "GET /drafts/:id": { params: Id; body: never; answer: DraftDTO };
  "PUT /drafts/:id": { params: Id; body: PatchDraftBody & { ifContentRevision?: string }; answer: DraftDTO };
  "DELETE /drafts/:id": { params: Id; body: never; answer: null };
  "POST /drafts/:id/resolve": { params: Id; body: { outcome: SendResolution }; answer: DraftDTO };
  "POST /drafts/:id/schedule": { params: Id; body: { sendAt: ISODateTime }; answer: DraftDTO };
  "DELETE /drafts/:id/schedule": { params: Id; body: never; answer: DraftDTO };
  "POST /drafts/:id/schedule-with-files": {
    params: Id;
    body: { sendAt: ISODateTime; attachments?: SendAttachmentWire[]; stagedAttachmentIds?: string[] };
    answer: DraftDTO;
  };
  "POST /drafts/:id/send": { params: Id; body: SendRequestBody; answer: SendAnswer };
  /** What happened under this key, asked before a staged retry re-uploads anything. */
  "GET /drafts/:id/send-attempt": {
    params: Id; body: never;
    answer: { found: true; firstSend: { status: string; at: string } } | { found: false };
  };
  /** Cancel asks the server. `draftId` is recorded only when this account holds that draft. */
  "POST /sends/withdraw": {
    params: None; body: { draftId: string | null };
    answer: { outcome: Exclude<WithdrawSendOutcome, "unsupported" | "unreachable">; firstSend?: { status: string; at: string } };
  };

  // ── requests waiting on another install ─────────────────────────────────────
  "GET /organizer-requests": { params: None; body: never; answer: { items: WaitingRequestWire[] } };
}

/** Every bound call, by name. */
export type RouteName = keyof Routes;
/** What a route's path names. */
export type ParamsOf<R extends RouteName> = Routes[R]["params"];
/** What a route's request carries; `never` for none. */
export type RequestOf<R extends RouteName> = Routes[R]["body"];
/** What a route answers at a 2xx. */
export type AnswerOf<R extends RouteName> = Routes[R]["answer"];

/** Every name any member of `T` has. */
export type NamesOf<T> = T extends unknown ? keyof T : never;

/**
 * A BODY HELD TO THE WIRE'S NAMES. A value can carry a name the wire's type does not have and
 * still be assignable to it: the compiler checks the names an object literal writes out, and not
 * those of a member spread into it (`...(x ? { renamed: x } : {})`) or of a value built
 * elsewhere, which is how an optional field is usually written. `B` is the value's own type and
 * `W` the wire's; intersected with `B`, this makes every name of `B` that `W` lacks one that must
 * be absent, so the line that writes it does not compile. It reads the body's own names, not
 * those of an object inside it; a list and a plain value have none and pass as they are.
 */
export type OnlyNamesOf<B, W> =
  [NonNullable<B>] extends [readonly unknown[]] ? unknown
    : [NonNullable<B>] extends [object] ? { [K in Exclude<NamesOf<B>, NamesOf<W>>]?: never }
      : unknown;

/**
 * A REQUEST BEFORE IT IS TRUSTED, as a server reads it: the wire's field names, each possibly
 * absent, and nothing believed about a value, an object's included. The service judges every
 * field, so the checks stay honest while the names stay tied to what a client sends.
 */
export type UntrustedBody<T> = { [K in NamesOf<T>]?: unknown };

/**
 * AN ANSWER BEFORE IT IS TRUSTED, as a client reads it: the same field names, each possibly
 * absent, each value unknown until it is checked. A list is `unknown` whole; an object keeps its
 * names, so a read can walk into it and still has to narrow every value it takes.
 */
export type Untrusted<T> =
  T extends undefined ? never
    : T extends null ? null
      : T extends readonly unknown[] ? unknown
        : T extends object ? { [K in keyof T]?: Untrusted<T[K]> }
          : unknown;

/** Every route a client of this tree is known to call. What is in no client's list may be the server's alone. */
export type ClientCall = RouteName | UnboundCall;
