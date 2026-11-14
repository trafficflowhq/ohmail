import type { ServerAddressOpts, ServerAddressWire, ServerSearchOpts, ServerSearchWire } from "../engine.js";
import type { WindowSyncFailure } from "../window-sync-failure.js";
import type { WindowSearchPhases } from "../search-phases.js";
import type {
  EngineMutation, MessageBodyBatchWire, MessageBodyWire, SyncChange, SyncResponse, UnsubscribeResult,
  WaitingRequestWire,
} from "../types.js";
import type {
  AttachmentWire, AutoFiledItemWire, AutoFiledUndoWire, AutoFiledWire, HeldReleaseGroupWire, HeldReleaseResultWire,
  HeldReleaseSenderWire, HeldReleaseWire, MutationAnswer, MutationOutcome, MutationQueued, ScreenerWaitingItemWire,
  ScreenerWaitingWire, StayedWhy, StayedWire, UnscreenedGroupWire, UnscreenedPileWire, UnscreenedResultWire, UnscreenedWire,
  WithdrawSendOutcome,
} from "@ohmail/wire";

/* What an act comes back as, and the Screener's and the attachment list's answers: from their one home. */
export type {
  AttachmentWire, AutoFiledItemWire, AutoFiledUndoWire, AutoFiledWire, HeldReleaseGroupWire, HeldReleaseResultWire,
  HeldReleaseSenderWire, HeldReleaseWire, MutationAnswer, MutationOutcome, MutationQueued, ScreenerWaitingItemWire,
  ScreenerWaitingWire, StayedWhy, StayedWire, UnscreenedGroupWire, UnscreenedPileWire, UnscreenedResultWire, UnscreenedWire,
  WithdrawSendOutcome,
} from "@ohmail/wire";

/**
 * ONE interface, two implementations (FixturesAdapter for ?demo/UI tests,
 * HttpAdapter for the real wire). The Engine is adapter-agnostic — swapping
 * Stage-2 live sync in is a construction-time config change, not a rewrite.
 */

/** `urgent`: the person is waiting for this read (an open); an HTTP adapter marks it `priority: "high"`. */
export interface ReadIntent {
  urgent?: boolean;
}

export interface SyncParams {
  /** The cursor of record ("0" ⇒ bootstrap). */
  since: string;
  limit?: number;
  /** Optional `?types=` filter (contract §3.1). */
  types?: string[];
}

/**
 * WHAT A DOOR SAYS ABOUT KEEPING A LETTER'S FILES FOR SEND LATER (`GET /hello`, mail 0179, 0180).
 * `kept`: it keeps them — the desktop's own engine (`scheduleFiles`), or a server that names a
 * horizon (`scheduleFilesDays`). `days`: that horizon, or `null` where none is named.
 */
export interface ScheduleFilesAnswer {
  kept: boolean;
  days: number | null;
}

export interface WithdrawSendAnswer {
  outcome: WithdrawSendOutcome;
  /** The send this key already holds, on `already_sent`/`unverified` — shape-checked by the adapter. */
  firstSend?: { status: string; at: string };
  /** On `unreachable`: a server answered (a 5xx, a 429, an unreadable body), so it counts as one. */
  answered?: boolean;
  /** The server's own `Retry-After`, in ms, when its refusal named one. */
  retryAfterMs?: number;
}

/**
 * The draft row a send wrote under its key: the revision it answered with, and which words it holds
 * (`sendFingerprint` of the mutation that wrote it, or `null` when that is not known — an older
 * record, or a save that did not land). A resume whose words differ, or are unknown, writes first.
 */
export interface CreatedDraftRow {
  id: string;
  revision: string | null;
  fingerprint?: string | null;
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
  /**
   * Tell the door that THIS WINDOW's pull failed, so the failure reaches the engine's own log. A
   * content-free record ({@link WindowSyncFailure}) and an optional capability: the desktop's
   * bridge adapter carries it to the local engine; the hosted client has no sink and stays silent.
   * Never awaited by the drain and never allowed to throw into it.
   */
  reportSyncFailure?(record: WindowSyncFailure): Promise<void>;
  /** One Search's timings ({@link WindowSearchPhases}), to the same door; absent on the hosted client. */
  reportSearchPhases?(record: WindowSearchPhases): Promise<void>;
  /** `mailboxIds`: the mailboxes a press is about; a local organizer rings only those. Absent, all. */
  requestPull?(opts?: { mailboxIds?: readonly string[] }): Promise<{
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
  /**
   * `createAttempted` is the engine handing BACK what a previous attempt under this key told it:
   * a non-idempotent create went out and its answer was unreadable. The adapter's own memory of
   * that dies with the adapter; the outbox entry carrying it does not.
   */
  /**
   * `createdRow` is the same hand-back for a send whose create WAS answered: the row this key made,
   * and the revision it was made at, so a replay sends that row instead of making another.
   * `onDraftRow` is how the adapter reports that row, awaited before the send request goes.
   */
  mutate(
    m: EngineMutation,
    opts: {
      idempotencyKey: string;
      createAttempted?: boolean;
      createdRow?: CreatedDraftRow;
      onDraftRow?: (row: CreatedDraftRow) => Promise<void>;
      /**
       * How long ago the press was made, in ms, measured by the ENGINE from the entry's persisted
       * press instant — a state verb's `x-ohmail-press-age`. Absent for every other kind.
       */
      pressAgeMs?: number;
      /**
       * Aborted when the engine ends this attempt and puts the change back on its queue (its hold
       * ceiling, or a person's Try again past the API's limit): nothing more of it may leave, a
       * transport's re-send after a renewal included. Never given for a send.
       */
      signal?: AbortSignal;
    },
  ): Promise<MutationAnswer>;
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
  fetchBody(messageId: string, opts?: ReadIntent): Promise<MessageBodyWire | null>;

  /**
   * CANCEL ASKS THE SERVER the send under `key` went to — {@link WithdrawSendAnswer}. REQUIRED, not
   * a capability: an adapter that could omit it would answer every Cancel from the disk alone, the
   * defect this exists to close. `draftId` is the row the send names, or `null`. Never throws.
   */
  withdrawSend(key: string, draftId: string | null): Promise<WithdrawSendAnswer>;

  /**
   * DOES THE SERVER THIS ADAPTER SENDS TO HONOUR A FORWARD'S KEPT FILES (`GET /hello`
   * `features.forwardParts`)? `null` is no answer. Optional: an adapter without it never offers Remove.
   */
  forwardPartsAnnounced?(): Promise<boolean | null>;

  /**
   * DOES THE SERVER THIS ADAPTER SCHEDULES WITH KEEP A LETTER'S FILES FOR A LATER SEND, AND HOW FAR
   * AHEAD ({@link ScheduleFilesAnswer})? `null` is no answer. Optional: without it, a letter with
   * files is never offered Send later.
   */
  scheduleFilesAnnounced?(): Promise<ScheduleFilesAnswer | null>;

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
  fetchBodies?(messageIds: string[], opts?: ReadIntent): Promise<MessageBodyBatchWire[] | null>;

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

  // ── mail held at the gate behind a rule its owner already wrote ───────────
  //
  // Both OPTIONAL, and absence is a real answer: a door that cannot say what
  // is held renders no release row at all, rather than a control that cannot
  // work. The FixturesAdapter issues zero requests and so implements neither.

  /**
   * `GET /screener/held-releases` — the sender groups whose mail is stuck at the gate, with the
   * rule that would file each one and how much of it there is.
   *
   * A derivation the server does over the caller's own rules and folder state, so it is asked
   * rather than mirrored: `/sync` has no vocabulary for it and clients refetch, the way the
   * mailbox and tracker facts work. Cheap — one grouped, indexed read; no mailbox is opened.
   */
  heldReleases?(): Promise<HeldReleaseWire>;

  /**
   * `GET /screener/stayed` — why each named message stayed where it is when its sender's rule
   * moved the rest: a reply, a triage state, a filing in another mail app, a failed check. Asked,
   * never mirrored: who placed a message and whether it was answered are the server's facts.
   */
  whyStayed?(ids: readonly string[]): Promise<StayedWire[]>;

  /**
   * `GET /screener/auto-filed` — what ohmail filed out of the Screener on its own, still where it
   * put it, newest first, each with why. Asked, never mirrored: who filed a letter is the server's
   * fact. A door without it answers nothing, and the Screener shows no notice.
   */
  autoFiled?(): Promise<AutoFiledWire>;

  /**
   * `POST /screener/auto-filed/undo` — PUT BACK: each named filing goes back to the Screener and no
   * automatic path files it again. Desired state only; the organizer moves the mail.
   */
  undoAutoFiled?(ids: readonly string[]): Promise<AutoFiledUndoWire>;

  /**
   * `POST /screener/held-releases` — THE PRESS. Releases the named groups, or every group when
   * `ruleIds` is omitted, and decides each named contact-only sender into the Ohbox; an omitted
   * `senders` decides none.
   *
   * It moves no mail itself: the server records your consent on each rule and re-opens that
   * rule's backlog, and the rule engine files the mail on its own pass. So the answer is what was
   * RELEASED, not what has already moved, and a second press over the same groups releases nothing.
   */
  releaseHeld?(ruleIds?: readonly string[], senders?: readonly string[]): Promise<HeldReleaseResultWire>;

  /**
   * `GET /screener/unscreened` — the Ohbox's sender groups nobody ever decided about, with how
   * much of each sender's mail is sitting there.
   *
   * A derivation the server does over the caller's own Ohbox against their own rules and
   * contacts, asked rather than mirrored for `heldReleases`' reason: the deciding fact is the
   * ARRIVAL GATE's answer, which `/sync` carries no vocabulary for. Given a `pile`, the same
   * question of News or Receipts, at any age: that pile's note.
   */
  unscreened?(pile?: UnscreenedPileWire): Promise<UnscreenedWire>;

  /**
   * `GET /screener` — one page of the waiting queue, read from the store rather than the mirror,
   * which is windowed while the queue is not. Optional: a door without it leaves the Screener to
   * the mirror's own derivation, and the surface says the count is this device's.
   */
  screenerWaiting?(page?: { cursor?: string; limit?: number }): Promise<ScreenerWaitingWire>;

  /**
   * `GET /organizer-requests` — what this door's requests to the organizer stand at. Optional: a
   * door without it leaves the waiting list to the requests this session sent itself.
   */
  organizerRequests?(): Promise<WaitingRequestWire[]>;

  /**
   * `POST /screener/unscreened` — THE PRESS. Sends the named sender groups, or every group shown
   * when `addresses` is omitted, to the Screener.
   *
   * It moves no mail itself: the server writes the intent a fresh arrival writes and the
   * organizer's reconciler carries it to the mail host. So the answer is what was SCREENED, not
   * what has already moved, and a second press over the same groups screens nothing. Given a
   * `pile`, it screens that pile's letters from senders nobody let in.
   */
  screenUnscreened?(addresses?: readonly string[], pile?: UnscreenedPileWire): Promise<UnscreenedResultWire>;

  /**
   * `POST /screener/held-releases/dismiss` — "not now", persisted per ACCOUNT so the offer stays
   * away on every device and session until the set changes. `fingerprint` is the identity the
   * read above answered; a set that moved in between stays offered because the stored value then
   * matches nothing.
   */
  dismissHeldRelease?(fingerprint: string): Promise<void>;

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
