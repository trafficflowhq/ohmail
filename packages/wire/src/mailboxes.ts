/**
 * A CONNECTED MAILBOX AS THE ACCOUNT'S OWN CLIENTS READ IT: identity, lifecycle, who organizes it
 * and how far its first sync has come. One long record; each field carries its own story.
 */
import type { ISODateTime } from "./base.js";
import type { MailboxDisabledReason, MailboxErrorCode, MailboxSyncBlockReason, OrganizerKind } from "./mailbox-states.js";

// ── Mailboxes ──
// Identity + lifecycle (real `status`/`displayName`/`lastSyncAt`/`authKind`
// columns) + a per-folder sync summary. Credentials live in the separate,
// envelope-encrypted `mailbox_credentials` table and are NEVER surfaced here.
export interface MailboxFolderSummary {
  folder: string;
  /** highestmodseq present ⇒ the folder has been scanned at least once. */
  hasSyncCursor: boolean;
  updatedAt: ISODateTime;
  /** The letters the server stated the folder holds when it was last opened; null before that. */
  serverExists?: number | null;
}

/** Whether new mail is being fetched, and since when it has not been ({@link MailboxDTO.fetching}). */
export interface FetchingDTO {
  behind: boolean;
  since: string | null;
}

export interface MailboxDTO {
  /**
   * Organizer or reader — what THIS install is to this mailbox (mail 0083). `'reader'` means
   * another install organizes it, or nobody has asked this one to: the mailbox is CONNECTED and
   * its mirror is growing; what a reader does not do is move, file or delete mail. It is the
   * field every client's banner and the "Organize here instead" button read, and it rides the
   * POLLED `GET /mailboxes` row rather than a live IMAP dial — at most one worker pass behind,
   * which the copy states rather than hides. The three organizer fields are UNCONDITIONAL, on
   * `syncBlockedReason`'s rule: every state they describe happens while `status` IS `connected`,
   * and gating them on a status would reproduce the invisibility they exist to end.
   */
  organizerRole: "organizer" | "reader";
  /**
   * Who organizes it, when this install does not — `null` when this install does, or when nobody
   * has ever claimed it. `kind` is `ORGANIZER_KINDS` ITSELF rather than a second spelling, with a
   * CHECK behind the column — three literals written here instead went a whole release without
   * `mobile`, so a phone's claim reached this field as a value the wire could not name. `name` is
   * the holder's own machine name, which is why it is on the ADMIN DTO's deny-list: the account's
   * own user may see what named their laptop, staff may not. `since` is when that install BECAME
   * the organizer, not when it was last seen — a banner says "since Tuesday", never "last seen 40
   * seconds ago", because a heartbeat on a screen invites a person to watch it.
   */
  organizedBy: { kind: OrganizerKind | null; name: string | null; since: string | null } | null;
  /**
   * Whether that organizer is still RENEWING — `'held'` — or stopped and left its claim behind
   * (`'stopped'`). `null` is "this install has not looked", which is every reader's row until its
   * first cycle and every organizer's row always.
   *
   * The two states want opposite offers on screen ("ohmail Cloud organizes this" versus "ohmail
   * Cloud stopped organizing this"), which is the whole reason the lease's three verdicts are not
   * collapsed into two anywhere they reach a person.
   */
  organizerState: "held" | "stopped" | null;
  /**
   * HAS THIS DOOR LOOKED AT WHO HOLDS THE MAILBOX. `false` only on a reader row nothing has peeked
   * for, where a NULL {@link organizerState} is "not looked" rather than "nobody"; setup withholds
   * Agree while it stands. Optional: a door older than the field sends nothing, which reads as yes.
   */
  organizerChecked?: boolean;
  /**
   * Is the claim on this mailbox this install's OWN — answered by the server, not inferred. A
   * client asking it from `organizedBy.kind` gets `cloud`, which is what a SECOND Cloud
   * deployment is too; their ids differ by design, so the category cannot answer an identity
   * question. The id itself is deliberately NOT on the wire — an internal deployment name every
   * viewer would receive for no purpose — so the server compares and sends the answer. `false`
   * where nobody holds the mailbox, where another install does, and where this deployment cannot
   * say: every one of those means "do not offer to give up this claim".
   */
  organizedByThisInstall: boolean;
  /**
   * How many of this mailbox's messages are SET ASIDE — unresolved `message_failures` rows, one
   * per message coordinate. The same count the desktop and phone read off their own ledger, so
   * every surface says the same sentence. Absent is a server that predates the field.
   */
  setAside?: number;
  /**
   * When somebody agreed to let ohmail organize THIS mailbox, or `null`. A different question
   * from `organizerRole`, and the pair is not derivable from either half: the role says who
   * organizes it NOW; this says whether permission was ever given. Freshly connected is `reader`
   * with a null; an organizer displaced by another install is `reader` with a stamp. The first
   * needs the consent screen; the second must NEVER be shown it again — re-asking for a granted
   * permission teaches people to click through consent. `organizeHere`'s precondition is `role =
   * 'reader' OR consent IS NULL`, unwritable with one field. UNCONDITIONAL: a mailbox awaiting
   * consent is `connected`.
   */
  organizeConsentedAt: ISODateTime | null;
  /**
   * When the organizing situation last changed, and when the person last acknowledged it
   * (0.14.1). The notice is DERIVED — `organizerEventAt > organizerEventSeenAt`, null `seenAt` =
   * never — not sent as a flag. Two instants make three properties hold: once per event on EVERY
   * door (a per-client flag shows the sentence once per client); two changes between two reads
   * COLLAPSE to the later one — the only statement still true; a dismissal cannot suppress a
   * LATER change. The sentence is NOT on the wire: derived at read time from the same facts a
   * stored sentence would copy — a copy drifts, and a server-rendered string cannot be
   * translated. UNCONDITIONAL, on the organizer fields' rule.
   */
  organizerEventAt: ISODateTime | null;
  organizerEventSeenAt: ISODateTime | null;
  /**
   * Mail 0151 — the letters that arrived while no device was organizing this mailbox and that the
   * person's rules would file, counted after this install began organizing it. Non-null only while
   * the offer waits for the person's answer (`POST /mailboxes/:id/gap-letters`); nothing moves
   * without that press. Absent on an older API, which reads as no offer.
   */
  gapLetters?: number | null;
  /**
   * Mail 0158 — the letters in the same window from senders the gate does not know, which the same
   * press puts in the Screener. Non-null exactly when {@link gapLetters} is (0 when none); absent
   * on an older API, which reads as 0.
   */
  gapStrangers?: number | null;
  /**
   * Can the holder of this mailbox accept a decision from a reader? (0.14.1) `true` only where a
   * reader's press has somewhere to go: the holder is still renewing AND its claim advertises the
   * request capability; `false` everywhere else. On the wire because the client must withhold a
   * control BEFORE the press: a decision bar wired to a refusal is the shape that let a released
   * build say "filed" and take it back forty-five seconds later. A derived boolean, not the
   * capability set: the set is a holder's self-description in somebody else's vocabulary, and a
   * customer DTO must not invite branching on unknown tokens. One question, one answer, computed
   * by the door's own rule.
   */
  organizerAcceptsRequests: boolean;
  /**
   * When this install last gave this mailbox up DELIBERATELY, or `null`. Written by the release
   * path and cleared by the next claim, so it is a statement about the CURRENT tenure rather than
   * a history: a mailbox released and then taken back reports null again, because "released" is
   * no longer what it is. On the wire so the mailbox pane can date its own permanent line: the
   * three reader shapes are otherwise indistinguishable from the outside — never organized,
   * holder vanished, and let go on purpose all read as a reader with no holder — and only the
   * third is something the person here did.
   */
  organizerReleasedAt: ISODateTime | null;
  /**
   * The standing ask to stop organizing this mailbox here, or `null`. Written the instant the
   * person presses "Stop organizing here, keep the mail", honoured by the organizer's own next
   * pass — so there is always a window, and on a server that will not confirm the removal there
   * can be many passes, in which the ask is real and nothing else on this row says so. A pane
   * reading only the role rendered an ordinary organized mailbox for that whole window: the
   * person pressed a button and the screen showed no trace, which on a slow server reads as the
   * button not working. Cleared by the pass that completes the release and by the countermanding
   * "Organize here" press. Projected raw: PENDING is the row's own state.
   */
  releaseRequestedAt: ISODateTime | null;
  /**
   * WHY the standing ask above has not finished, or `null` (mail 0121). The one value is
   * `sibling_lapse`: the release was refused because a FRESH claim carries this install's id
   * under a nonce it never wrote — a restored image or clone — and the request stands until that
   * claim lapses. Without the discriminator a pane cannot tell this refusal from an ordinary
   * pending confirm, and it rendered "Stopping…" as a false state at exactly the moment a person
   * is fighting a clone. Never set while {@link releaseRequestedAt} is `null`; coerced to the
   * closed set at projection, so a widened column value reads as no refusal rather than a state
   * no pane has a sentence for.
   */
  releaseRefusal: "sibling_lapse" | null;
  /**
   * THE STANDING PRESS TO ORGANIZE THIS MAILBOX HERE, or `null` — the takeover's pending half,
   * on the same argument as {@link releaseRequestedAt}: the stamp is spent by the gate's next
   * pass, and until then the ask exists only on this column. A client that keeps its own
   * "asked for" note can end that note the moment either this clears or the role moves,
   * instead of showing it for ever beside a row that has long since answered.
   */
  takeoverAuthorizedAt: ISODateTime | null;
  /**
   * When the WALL stood this mailbox down, or `null` (mail 0135). Set only by the park of a closed
   * account; a release the person asked for is `null` here. While set, the row is paused rather than
   * released: organizing resumes on its own once the account is open, so no surface may say the
   * person stopped it. Cleared by the promotion or stand-down that answers the resume.
   */
  organizerParkedAt: ISODateTime | null;
  id: string;
  provider: string;              // 'imap' today; 'exchange' planned
  address: string;
  /**
   * IS THIS ADDRESS THE ACCOUNT'S OWN: the mailbox is neither erased nor removed (a stood-down one is
   * still the account's). The one set the router, the rule refusal (`own_address`) and both surfaces
   * read (`@trafficflow/db#mailboxCountsAsOwn`). Optional: a door older than the field sends nothing,
   * which a client reads as yes.
   */
  addressIsOwn?: boolean;
  displayName: string | null;
  status: "connected" | "error" | "disabled";
  authKind: "password" | "oauth";
  lastSyncAt: ISODateTime | null;
  // ── WHY it failed (mail 0023). All four are null/0 whenever `status !== 'error'`: the
  //    worker clears them in the same statement that writes `connected`, so a client can never
  //    render "connected" beside a stale reason.
  //
  //    `errorDetail` is an ALLOWLISTED token — an IMAP response code, a Node errno, a TLS
  //    constant, an SQLSTATE — and never an error message. That rule is enforced at the write
  //    (`markMailboxFailed`, in the worker) rather than here, because this DTO
  //    is not the only reader: the admin console projects the same column, and a raw message
  //    can carry RFC822 header bytes, which staff may never see.
  errorCode: MailboxErrorCode | null;
  errorDetail: string | null;
  failedAt: ISODateTime | null;
  /** Attempts within the CURRENT outage. Not the worker's backoff counter — see the column. */
  retryCount: number;
  // Why a `connected` mailbox is not being synced (mail 0029). PROJECTED UNCONDITIONALLY, and the
  // asymmetry with the four fields above IS the point: in every scenario these describe, the
  // status is `connected`. An infrastructure fault must never render as "your mailbox is broken",
  // earn a backoff, or quarantine anything — the row keeps saying `connected` and says WHY here.
  // `syncBlockedReason` is a closed set of three with a CHECK; a stable key, not a sentence.
  // NULL/NULL is the normal case. And `null` here does NOT mean "not blocked": the service
  // narrows an unrecognised member to `null` and forwards `syncBlockedSince` unconditionally —
  // "blocked, reason unrecognised" is a state the client must render. This field is COPY;
  // `syncBlockedSince` is the predicate. Widening to `string` was rejected.
  syncBlockedReason: MailboxSyncBlockReason | null;
  /**
   * When the CURRENT block began — `coalesce`d on write, so it does not restart every pass — **and
   * the authoritative "this mailbox is not being synced" signal on this wire.**
   *
   * `non-null reason ⇒ non-null since` is held by the five writers in one statement each, NOT by a
   * constraint: `0029_mailbox_sync_block.sql:113` constrains membership only. Narrowing this field
   * for symmetry with the one above reinstates the original blocked-but-invisible bug.
   */
  syncBlockedSince: ISODateTime | null;
  /**
   * Why a `disabled` mailbox is disabled, when the reason is the organizer lease and not a person
   * (mail 0027). A connect succeeded, then lost the claim to a LOCAL install with a stale
   * heartbeat; the stand-down cleared the error and block columns, and with nothing carrying the
   * fact the client rendered "disconnected". GATED on `status === 'disabled'` — the same rule as
   * the ungated pair, pointing the other way: meaningful under no other status, and ungated it
   * would ship `{connected, organized_elsewhere}` for the whole re-enable window. `null` here
   * means "not stood down": under `disabled` a null reason is the ORDINARY DISCONNECT, so an
   * unrecognised member must NOT narrow to `null` — the closed set ships its own catch-all.
   */
  disabledReason: MailboxDisabledReason | null;
  /**
   * When this mailbox's FIRST import actually finished (mail 0038) — stamped by the worker the
   * first time a cycle completes with no backlog remaining, NULL until then. The one honest
   * end-of-import signal: `lastSyncAt` is shared across every mailbox a cycle served and lands
   * after the FIRST cycle whether or not a backlog remains, so a mailbox thirty seconds into a
   * long import already carries one. Per-mailbox and late — `mail-state.ts` reads it as a FLOOR
   * (`null` = still importing), so a partial mailbox cannot present as complete just because a
   * client's mirror stopped growing. Projected UNCONDITIONALLY: meaningful in every lifecycle
   * state, and gating it would hide exactly the partial-import case it discloses.
   */
  initialImportCompletedAt: ISODateTime | null;
  /**
   * The forwarding-detection notice's evidence pair (mail 0078) — a quiet, dismissible fact about
   * a HEALTHY mailbox: a provider-level forward once diverted every inbound mail before IMAP
   * storage while the mailbox synced perfectly. `inboundQuietSince` non-null means the worker's
   * inbound-quiet pass recognised an episode — a connected, fully-imported mailbox whose genuine
   * inbound has been zero for the pass's window; the value is the newest genuine inbound date.
   * `inboundQuietDismissedAt` is the dismissal; the CLIENT owns the comparison: show iff `since`
   * is set, the health claims hold, and `dismissedAt` predates `since`. PROJECTED
   * UNCONDITIONALLY: every state here happens while `status` IS `connected`.
   */
  inboundQuietSince: ISODateTime | null;
  inboundQuietDismissedAt: ISODateTime | null;
  /**
   * How many of OUR OWN filings this mailbox has not yet applied. The API never opens IMAP — a
   * decision writes `folder_state` and the WORKER moves the mail next cycle — and between press
   * and cycle the mail is filed in ohmail, not on the server; that state was indistinguishable
   * from a finished job. What it counts: `pending` AND `last_set_by = 'us'` AND `desired <>
   * observed` — an EXTERNAL row is the user's own tidying; agreeing folders are a no-op; `failed`
   * is a different sentence. Projected UNCONDITIONALLY: a status gate would zero it on exactly
   * the rows it describes. Read with `typeof === "number"`, never `> 0` on a possibly-absent
   * field — and never render "Filing 0 messages".
   */
  pendingMoves: number;
  /**
   * The same outstanding filings, split by the operand that decides (mail 0097). One number
   * covered four situations: the shell read "Filing 1 message… the server is catching up" for ten
   * minutes — the COUNT was right, the sentence was the only one the single field could produce.
   * Three of the four are not "catching up": the rotation has not reached this mailbox (a turn
   * versus a stall); the server REFUSED and the retry is deferred; or a READER install decided,
   * and the holder applies it on its own schedule. Present WITH ZEROS, never absent: absent means
   * "this server predates the field", so a conditional projection would make a deployment that
   * CAN tell indistinguishable from one that cannot.
   */
  filing: {
    /** Outstanding filings the next reconcile turn will pick up (`next_attempt_at` null or past). */
    due: number;
    /**
     * Outstanding filings that are ASLEEP — refused, retry scheduled ahead.
     *
     * The row the reported sentence was about. `due + deferred` is {@link pendingMoves}; a client
     * that cannot tell the two apart cannot say anything true about either.
     */
    deferred: number;
    /**
     * When the OLDEST outstanding filing was written, ISO-8601 UTC, or null when none is.
     * `folder_state.updated_at` — the reconciler's own queue order (`listPendingFolderStates`
     * orders by it) and the honest "waiting since": the intent writers stamp it and
     * `deferFolderReconcile` deliberately does not — a refusal is not a re-filing. NOT a creation
     * stamp, considered and rejected: `folder_state` is keyed by message and upserted, so a
     * `created_at` dates the message's FIRST filing and would report weeks of waiting over a
     * decision made a second ago.
     */
    oldestPendingAt: string | null;
    /**
     * When the SOONEST deferred filing may be attempted again, or null when none is deferred.
     *
     * MIN and not max: it is when something will next happen, which is what a sentence promising
     * a retry has to name.
     */
    nextAttemptAt: string | null;
    /** The highest refusal count among the outstanding filings — 0 when none has been refused. */
    attempts: number;
    /**
     * WHY the worst-off outstanding filing was refused — one of
     * `refused | no_such_folder | read_only | over_quota`, or null.
     *
     * Read from the same row {@link attempts} comes from, so the two halves of one sentence are
     * about one message. NARROWED against the closed set rather than projected verbatim: a value
     * a newer worker writes and this API does not know becomes null, and a client renders its own
     * "your server would not say why" — never the raw string, which is one step from a mail
     * server's own words on somebody's screen.
     */
    lastRefusalClass: string | null;
    /**
     * The STUCK filings alone (`filingStuck`: waited five minutes, or refused twice) — how many,
     * the oldest of them (ISO-8601 UTC, or null), and the class the worst of them carries (the
     * closed set above, or null when none of them was refused). The stuck sentence reads these,
     * so its count, clock and reason are about the same rows.
     */
    stuck: number;
    stuckSince: string | null;
    stuckRefusalClass: string | null;
    /**
     * WHEN THIS READ HAPPENED, ISO-8601 UTC.
     *
     * The strip runs a clock (nothing in the mirror moves when the worker drains this backlog, so
     * a state keyed on mirror movement would freeze) while the facts behind it are re-fetched
     * every 30 s and on nothing else. So the number was being animated up to thirty seconds
     * stale. With this the surface can state when it last looked instead.
     */
    asOf: string;
    /**
     * When the organizer's last pass finished, ISO-8601 UTC, or null when this deployment cannot
     * say. The fact that separates a TURN from a STALL: a pending filing waits for the rotation,
     * so one outstanding move is unremarkable while passes are landing and alarming while none
     * are. `null` on every local tier — there is no heartbeat to read — and a client must render
     * SILENCE on that clause rather than "no pass has ever run": a desktop install organizes its
     * own mailbox in-process and must never be told its organizer is dead.
     */
    lastCycleAt: string | null;
  };
  /**
   * IS NEW MAIL BEING FETCHED FOR THIS MAILBOX — one fact about the server's organizer, for the rows
   * it is on duty to fetch: every mailbox that is not disabled, also one it reads for another install's
   * organizer, unless it left the row out (`syncBlockedReason` `account_closed` or `at_capacity`).
   * `behind: true` means nothing is fetching, or fetching has fallen behind (`since`: the last pass
   * that finished, or null when none is on record); a pull is kept and served when fetching resumes.
   * `null` means this server does not say: a row off that duty, or a deployment that keeps no such
   * record (every local tier). Render SILENCE on null, never "up to date". ABSENT is an older server.
   */
  fetching: FetchingDTO | null;
  /**
   * The biggest message this mailbox's submission server said it will accept, in bytes — its own
   * RFC 1870 `SIZE` announcement, recorded by the connect-time SMTP probe (mail 0055). The
   * compose surface used to state a CONSTANT ceiling — the hosted API's body limit — too small
   * for a local install and too LARGE for a provider capping submission below it, where the
   * product accepted the send and let the server bounce it. `null` means no announced ceiling (no
   * `SIZE`, the bare keyword, or `SIZE 0` — RFC 1870 §6); ABSENT is an API older than the column.
   * NOT the cap on its own: the applying ceiling is the SMALLER of this and what the host can
   * take — `effectiveAttachmentCap` in `send-service.ts` is the authority.
   */
  smtpMaxSizeBytes?: number | null;
  /**
   * Can a sender be confirmed at this mailbox — an authserv-id known for the IMAP host its credential
   * records (`providerAuthservIds`), or an organizer that checks the sender's own DKIM signature
   * where none is. `false`: every verdict there is `unavailable`, so nothing of its mail is
   * unsubscribed from automatically. ABSENT where no host is recorded, which says nothing.
   */
  providerConfirms?: boolean;
  /**
   * The provider's OWN Junk folder, canonical path, as discovery resolved it at the last attach
   * (mail 0065 — SPECIAL-USE `\Junk` first, then the well-known leaf names). It is on the wire
   * for one reason: ohmail never mirrors that folder, so mail the provider junked is in no list
   * and no search here, and the surfaces where somebody hunts for missing mail can only NAME the
   * place it went if they are told its name — "Junk" on iCloud, "Spam" on Gmail, "Spamverdacht"
   * on GMX. `null` is two states the client does not need apart, because both mean "say nothing":
   * the mailbox has no Junk folder, or nothing has attached to it yet. ABSENT is an API older
   * than this field. The path is the account's own folder name and goes to the account's own
   * clients; it is not on the admin projection.
   */
  junkFolder?: string | null;
  /**
   * The Sent folder the attach recorded (mail 0132), canonical path, so a client knows Sent by
   * the server's own name ('Envoyés') beside the Sent-shaped ones. `null`: none recorded or not
   * attached yet; ABSENT: an older API. The account's own folder name, like {@link junkFolder}:
   * not on the admin projection.
   */
  sentFolder?: string | null;
  /**
   * Why sending is not set up for this mailbox — a reason code, or `null` when it is. An outgoing
   * server is not a reason to stop receiving: a refused submission dial used to abort the whole
   * connect, so a mailbox whose incoming server worked could not be connected at all. The connect
   * succeeds now: the incoming credential is stored, no `smtp` row is written (an unproven
   * submission credential is what the service refuses to store), and this carries the probe's own
   * reason — `auth` · `connect` · `tls` · `timeout` · `unknown`, the set the connect form already
   * renders. `null` means sending is settled — proved when the password was stored, not a
   * promise. The repair is a normal credential patch, which re-probes.
   */
  sendingUnsettledReason?: string | null;
  /**
   * How much mail is in this mailbox — the only OPT-IN field on this DTO. An aggregate over the
   * account's ENTIRE `messages` table on a POLLED route (the shell reads it every 30 s per tab);
   * unconditional would put a full history scan behind a heartbeat. Computed only for `GET
   * /mailboxes?counts=1`, in ONE account-scoped statement grouped by mailbox. ABSENT and `0` are
   * different answers: `0` is a real state — a freshly connected mailbox during its first import;
   * ABSENT means nobody asked. A renderer reads `typeof === "number"` and shows NOTHING when
   * absent — never "0 messages", which would tell somebody their mail vanished because a status
   * poll happened to land last. Whole mail, unread or not.
   */
  messageCount?: number;
  /**
   * An erasure of ohmail's copy still running (mail 0126): present only on a row whose erasure
   * was asked for and has not finished, with the messages it has left. The worker's
   * `mailbox_erasure` pass moves it; a finished erasure's row is not listed at all.
   */
  erasure?: { remaining: number };
  /**
   * How much mail the SERVER says is in there — the first pull's DENOMINATOR. {@link
   * messageCount} is the numerator; until this there was no denominator: the adapter read
   * `EXISTS` off every SELECT and threw it away. Mail 0083 added `mailbox_folders.server_exists`;
   * this is that column, summed. UNCONDITIONAL: the projection already reads these rows, so the
   * sum costs nothing. A sum over OPENED folders, so it can go UP — a floor that moves — and it
   * can be smaller than {@link messageCount}; a caller clamps `remaining` at zero and shows
   * nothing at zero. ABSENT covers both no-number cases; a `0` floor would claim the server holds
   * no mail — an uncounted server has no answer at all.
   */
  serverMessageCount?: number;
  /**
   * WHERE A BUDGETED FIRST SYNC IS CONTINUING (mail 0115) — the folder the last pass's byte budget
   * stopped at, or `null` when no pass stopped. A first sync of a mailbox with many large-first
   * folders runs in bounded passes and pauses between them; the strip showed a count that stepped
   * and then sat still, with nothing saying why. This is what the sentence "First sync continues
   * at …" is rendered from, and it is the PERSISTED stop rather than the adapter's in-memory copy
   * — the fact has to survive the restart it is about. `null` covers both say-nothing cases (no
   * stop, or no pass has run) on {@link junkFolder}'s rule. The path is the account's own folder
   * name and goes to the account's own clients; it is not on the admin projection.
   */
  firstSyncStopFolder?: string | null;
  folders?: MailboxFolderSummary[];
  createdAt: ISODateTime;
  // NOTE: intentionally NO credential field — creds are envelope-encrypted at rest
  // in `mailbox_credentials` and never leave the server.
}
