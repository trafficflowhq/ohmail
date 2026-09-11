/**
 * The mail schema as SQLite spells it — the same tables, names and constraints. Every identifier
 * here also exists in `schema-mail.ts`, and it is the SAME identifier: services are typed against
 * the Postgres twin, and a device build swaps this module in without changing a line;
 * `schema-twin-parity.test.ts` compares the twins table by table. What changes: ids are text,
 * instants are epoch-millisecond integers, JSON is text, booleans are integers, large counters
 * keep `bigint` through a native 64-bit column. The generated text-search columns have no
 * counterpart: full-text lives in external-content indexes kept current by triggers. MAINTAINED,
 * not generated.
 */
import { sqliteTable, text, integer, real, unique, uniqueIndex, index, primaryKey, customType, check } from "drizzle-orm/sqlite-core";
import { sql, desc } from "drizzle-orm";

/**
 * A 64-bit counter that stays a `bigint` in TypeScript and a native integer in the store.
 *
 * The query builder's own large-integer column is a blob, and a blob neither compares nor orders
 * — which these columns do, in the sync cursor and in the change log's sequence.
 */
const int64 = customType<{ data: bigint; driverData: string }>({
  dataType() { return "integer"; },

  /**
   * BOUND AS A DECIMAL STRING, not as a bigint.
   *
   * The store's column is a native 64-bit integer either way — a numeric string binds to an
   * INTEGER column exactly, by affinity. What differs is the HOST: the device's SQLite binding
   * accepts a string, a number, null, a boolean or bytes, and NOT a bigint, so passing one through
   * unchanged either fails the bind or is coerced to a double and silently loses bits above
   * 2^53 — which for a UIDVALIDITY or a change-log sequence is a message pointing at the wrong
   * mail. Node's own binding accepts bigints, so a test on this machine cannot see it.
   */
  toDriver(value) { return value.toString(); },

  /**
   * And read back LOUDLY, because the return side cannot be made exact from here.
   *
   * A host that hands back a double for an INTEGER column has already lost the low bits by the
   * time this runs; there is nothing to recover. Refusing names the value and the column instead
   * of returning a number that is quietly one or two away from the one stored.
   */
  fromDriver(value) {
    if (typeof value === "bigint") return value;
    if (typeof value === "string") return BigInt(value);
    const n = value as unknown as number;
    if (!Number.isSafeInteger(n)) {
      throw new Error(
        `this store returned ${n} for a 64-bit column, and a value that large cannot survive a ` +
        "double. The host's binding must return a string or a bigint for these columns.",
      );
    }
    return BigInt(n);
  },
});

/** The current instant, in the milliseconds-since-epoch the timestamp columns store. */
const NOW_MS = sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;

/**
 * A random identifier, so a row inserted without one still gets one.
 *
 * The application supplies these everywhere it inserts; the default exists for the same reason
 * the Postgres twin's does — so a hand-written statement cannot leave a primary key empty.
 */
const UUID_V4 = sql`(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))`;

export const mailboxes = sqliteTable("mailboxes", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  provider: text("provider").notNull(),      // 'imap'
  address: text("address").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  // ── Migration 0007: real mailbox lifecycle fields. Server defaults so
  // the 0006-era rows stay valid on the additive cutover (no backfill needed). ──
  displayName: text("display_name"),                                       // user-facing label (nullable)
  status: text("status").notNull().default("connected"),                   // connected|error|disabled
  lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),           // last successful worker cycle (nullable)
  authKind: text("auth_kind").notNull().default("password"),               // password|oauth
  // Mail 0023 — WHY a mailbox failed, not merely THAT it did. `status` alone was the whole
  // record, so Settings could only say "something went wrong" — a disk-full incident once stayed
  // opaque for hours. The four columns are evidence, never control flow: nothing reads them to
  // decide, and NULL is "not recorded". `errorDetail` IS NEVER A RAW ERROR STRING: a member of a
  // CLOSED allowlist held by the worker's classifier (an IMAP response code, a Node errno, a TLS
  // constant), checked at the single write site, because a throw out of the sync cycle can embed
  // message bytes and a login failure's server text can echo the credential. MEMBERSHIP, not
  // shape: imapflow derives `serverResponseCode` from the SERVER's own bracket atom, so a hostile
  // endpoint answering `NO [SECRETPASSWORD123]` passed the old regex and reached the Settings
  // pane. An unrecognised token stores NULL.
  errorCode: text("error_code"),                                           // a MAILBOX_ERROR_CODES member, or null
  errorDetail: text("error_detail"),                                       // allowlisted token, or null
  failedAt: integer("failed_at", { mode: "timestamp_ms" }),                // when the CURRENT outage began (COALESCE on write)
  retryCount: integer("retry_count").notNull().default(0),                 // attempts within the current outage
  // Mail 0039 — WHEN the leader may next try this mailbox. The quarantine backoff, made durable:
  // it used to live only in the worker's in-process map, so a parked mailbox had two exits — the
  // ladder expiring, or a restart — and nothing outside that process could release one. NULL
  // means no backoff: never quarantined, cleared by a completed sync, or released by an operator.
  // Written by `markMailboxFailed`; cleared by every writer that makes a backoff untrue and by
  // the admin release. NOT a second `retry_count`: that is the SIZE of the current outage; this
  // is the one fact neither carries — WHEN. The ladder's attempt count stays in memory, so a
  // release does not reset it: freeing a mailbox must not hand a struggling provider a fresh
  // minimum-interval retry loop.
  retryAfter: integer("retry_after", { mode: "timestamp_ms" }),
  // ── Mail 0025 — the once-per-mailbox inbox-shaping kickstart ran ──
  //
  // The worker scans the Sent folder at CONNECT, imports its recipients into `contacts` (which
  // IS `knownSenders`) and re-routes the Screener backlog once. This column is the whole of the
  // idempotency: NULL means "never run", a timestamp means "done, never again". It is a MARKER
  // and not a schedule — nothing reads it to decide anything other than skip-or-run, and the
  // worker writes it only AFTER the pass succeeds, so a crash mid-kickstart retries on the next
  // attach rather than leaving a half-shaped mailbox marked complete.
  kickstartAt: integer("kickstart_at", { mode: "timestamp_ms" }),
  // Mail 0027 — the organizer lease. `disabledReason` is WHY this mailbox is `status='disabled'`
  // when the reason is the lease rather than a person. A CLOSED set (`MAILBOX_DISABLED_REASONS`)
  // with a CHECK, because it is read by the account's own user and must never hold a string a
  // mail server chose — the finding that closed `error_detail`, applied before it can happen
  // here. NULL for every non-lease disable, which is what tells "Organized by Cloud" apart from
  // an ordinary disabled mailbox. EVIDENCE plus one decision, and the decision is the user's:
  // nothing re-enables a mailbox except an explicit PATCH — ceasing to organize is always
  // automatic; BECOMING an organizer always requires an explicit human action.
  disabledReason: text("disabled_reason"),
  // When a human explicitly asked THIS organizer to take this mailbox over from another one.
  // Consumed on the first successful gate: it authorizes one BECOMING, never a standing right,
  // or a lapse-then-resubscribe would silently seize a mailbox back from a deliberate local
  // choice (the lease's "No seize-back" rule).
  takeoverAuthorizedAt: integer("takeover_authorized_at", { mode: "timestamp_ms" }),
  // Mail 0083 — the ORGANIZING ROLE, which is not the connection. A row carries two independent
  // facts and `status` used to hold both: `status` is whether ohmail can REACH this mailbox; this
  // column is whether ohmail ORGANIZES it. Encoding the second in the first was right while the
  // only states were "ours" and "not ours at all", and wrong once "somebody else organizes this"
  // means BE ANOTHER MAIL CLIENT — connected and syncing, so it cannot be `disabled`. NOT NULL
  // with the pre-migration behaviour as default, safe in both deploy directions. `reader` IS the
  // pre-consent state as well as the lost-the-lease one, by design: `POST /mailboxes` creates a
  // consent-less reader, so a fresh connect mirrors at once and moves nothing; what separates the
  // two is {@link organizeConsentedAt}. Closed by `mailboxes_organizer_role_closed`; members are
  // `ORGANIZER_ROLES`, reconciled by a real-Postgres test.
  organizerRole: text("organizer_role").notNull().default("organizer"),
  // WHO holds the lease when we do not — the columns a banner needs, written from
  // `StandDownVerdict.by` at the stand-down and refreshed each reader cycle. `organizedByKind` is
  // the same closed set as `disabledReason`'s suffix, behind a CHECK, for the same reason: read
  // by the account's own user, so it must never hold a string a mail server chose.
  // `organizedByName` is the holder's `X-Ohmail-Display-Name` — a customer's machine name:
  // header-safe and capped at `ORGANIZED_BY_NAME_MAX` at the single write site, and on the admin
  // DTO deny-list (staff see role and kind, never the name). No CHECK — free text closes no set.
  // `organizedSince` is the holder's `X-Ohmail-Claimed-At`: when they BECAME organizer, distinct
  // from when last seen — the heartbeat is deliberately not persisted.
  organizedByKind: text("organized_by_kind"),
  organizedByName: text("organized_by_name"),
  /* WHICH INSTALL, not which kind. `organized_by_kind` is one word about a CATEGORY and answers "what
     sort of thing holds this", which is only the same question as "is this us" when there is one
     install per kind — and the Cloud id is scoped by environment precisely so that two Cloud
     deployments over one mailbox is a designed-for state. NULL means "we cannot say it is ours",
     and every caller must read it as NOT ours: the release matches on this id, so a category
     comparison cleared rows over claims it could not remove. */
  organizedByInstallId: text("organized_by_install_id"),
  organizedSince: integer("organized_since", { mode: "timestamp_ms" }),
  /**
   * The lease's `LeaseOccupancyState` — `'held'` (somebody is renewing) or `'stopped'` (somebody
   * WAS organizing and nothing has renewed since). NULL is "we have not looked". The old argument
   * that this must never be persisted rested on a premise that moved: a stood-down mailbox used
   * to leave the roster, so nothing would refresh the column. A READER stays connected and
   * cycles, so there is a later writer — every reader cycle refreshes this from a `peekLease`
   * read (the APPEND-less IO, so looking costs no claim), and the value is never older than one
   * poll interval. The mailbox with no writer is a tombstone, which nothing displays. Closed by
   * `mailboxes_organizer_state_closed`.
   */
  organizerState: text("organizer_state"),
  /**
   * Mail 0089 — what the holder OFFERS a reader. `X-Ohmail-Capabilities` off the holder's own
   * claim, comma-joined and lowercased ({@link capabilitiesColumn}) — the fifth holder column,
   * refreshed at the same three write sites as {@link organizerState} and for the same reason:
   * the API tier has no live IMAP connection, so whether a reader's decision may become a REQUEST
   * has to be answerable from this row alone. NULL means "we have not looked" OR "the holder
   * advertises nothing" — the same two-fact conflation {@link organizerState}'s NULL carries,
   * safe for the same reason: both read as "do not offer a request", the fail-safe direction. No
   * CHECK — see the migration header for why a closed set is wrong here.
   */
  organizedByCapabilities: text("organized_by_capabilities"),
  /**
   * When a human asked THIS install to organize THIS mailbox — the consent event, per mailbox.
   * NULL means nobody has: the state `POST /mailboxes` creates — the mirror builds, and not one
   * message moves. Written by `MailboxService.organizeHere` (the one ceremony, every door) in the
   * same transaction as `takeoverAuthorizedAt` and as `accountSettings.screeningBaselineAt` while
   * that is still NULL: without a baseline there is no cutoff and the ENTIRE backlog goes to the
   * Screener. `COALESCE(., now())` on write: consent is the FIRST time, and re-running onboarding
   * must not move the record. Backfilled to `created_at` for connected rows: connecting WAS the
   * consent under the old copy.
   */
  organizeConsentedAt: integer("organize_consented_at", { mode: "timestamp_ms" }),
  /**
   * Mail 0088 — when the organizing situation last changed, and when acknowledged. A NOTICE as
   * two instants rather than a flag: a client shows the line iff `organizerEventAt >
   * coalesce(organizerEventSeenAt, -infinity)`. Three properties a boolean loses: once per event
   * on every door at once; two events between two reads collapse to the later one; a dismissal
   * cannot suppress a LATER event. `organizerEventAt` is written by EVERY writer of the (role,
   * state, holder) triple — a census: a writer that changes who organizes and does not stamp this
   * leaves a client showing yesterday's sentence. No kind column beside them: the sentence is
   * derived at read time from facts a stored kind would copy, and a copy drifts.
   */
  organizerEventAt: integer("organizer_event_at", { mode: "timestamp_ms" }),
  organizerEventSeenAt: integer("organizer_event_seen_at", { mode: "timestamp_ms" }),
  /**
   * Mail 0088 — "stop organizing this mailbox, keep my mail", as a REQUEST. The mirror of {@link
   * takeoverAuthorizedAt}, a one-shot for the same reason: it authorizes one CEASING, not a
   * standing refusal. The route that writes it opens no socket — expunging the claim is an IMAP
   * write, and those belong to the process holding the connection. The organizer's next pass
   * honours it FIRST, before it reads the lease: releases the claim, writes the reader role with
   * holder columns cleared, closes the appointments it can no longer keep, clears this column.
   * Written under the same `FOR UPDATE` as `organizeHere` and `delete`, so a release racing a
   * claim-back cannot leave a row both asking to stop and authorized to start.
   */
  releaseRequestedAt: integer("release_requested_at", { mode: "timestamp_ms" }),
  /**
   * Mail 0088 — and the record that the ceasing HAPPENED. {@link releaseRequestedAt} is the ASK,
   * cleared when honoured; this is what the row keeps afterwards, because a release is otherwise
   * INDISTINGUISHABLE from a stand-down whose winner went away — both are `reader` with a consent
   * stamp and four NULL holder columns (the per-cycle peek NULLs them on an empty folder).
   * "Somebody took this mailbox" and "you stopped organizing it here" are different sentences on
   * the claim-back screen, and the first owes a pending scheduled send an ending. {@link
   * standDownMemory} answers `null` for a released row, so neither fires for a ceasing nobody
   * else caused. Cleared by every promotion, so it describes the CURRENT state.
   */
  organizerReleasedAt: integer("organizer_released_at", { mode: "timestamp_ms" }),
  // Mail 0065 — the provider's OWN Junk and Trash folders, as discovered at connect. Canonical
  // `/`-delimited paths, resolved by `ImapAdapter.findSpecialFolders` (SPECIAL-USE first, then
  // the name belts) and re-written on every connect, so a mailbox that gains or renames the
  // folder heals on its next attach. NULL means the mailbox genuinely has neither the flag nor a
  // recognisable name — never "not yet asked" for a mailbox attached since this column landed.
  // They exist because the API may never open IMAP: a delete must be refused UP FRONT when the
  // mailbox has no Trash (`no_trash_folder`), and the reconciler must know where a spam verdict
  // files without a LIST per pending row. Evidence for those two decisions only; the folders they
  // name are never watched.
  junkFolder: text("junk_folder"),
  trashFolder: text("trash_folder"),
  // Mail 0073 — per-mailbox "Use folders", stored as the EXCEPTION (FOLDERS-SPEC.md §17). The
  // account's `folders_enabled_at` stays the master switch; under it every mailbox participates
  // BY DEFAULT, so NULL — and a failed read — mean "this mailbox's folders show", and a timestamp
  // is "when this mailbox was switched OFF" (the support question). The sign is deliberately the
  // master's opposite: the feature defaults closed, but within an opted-in account the
  // per-mailbox default is open, because all-mailboxes-showing is what the account just asked
  // for. Read through the mailbox join `listUserFolders` already makes; written only by
  // `setMailboxFoldersEnabled`, whose transaction also writes the folder change rows so a live
  // rail follows the switch. The worker neither reads nor writes it — the passive read is not
  // consent-gated; SHOWING is.
  foldersDisabledAt: integer("folders_disabled_at", { mode: "timestamp_ms" }),
  // Mail 0075 — the per-mailbox SIGNATURE. The text a compose offers under the message when this
  // mailbox is the sender; NULL is "no signature", the default. STORED TEXT ONLY: whether an
  // outgoing message carries it is the compose surface's decision (the signature is a visible,
  // removable block that serializes into the body at send exactly as shown), so the send path
  // never reads this column. Written by `setMailboxSignature`, whose transaction moves the
  // account-settings stamp and appends the `settings` change row — the same wake the folders dial
  // rides — so open composers everywhere re-read `GET /consent` and swap to the new text live.
  // Bounded at the write site (`MAILBOX_SIGNATURE_MAX_CHARS`, a 400), not by a CHECK: free text
  // closes no set, and a byte bound in the database would answer 23514 to a person typing.
  signature: text("signature"),
  // Mail 0076 — the one-time Quarantine to Junk sweep, recorded as a COMMAND (FOLDERS-SPEC.md
  // §16.1: one press, one direction, then the offer is gone). A doorbell with a name, on
  // `sync_requested_at`'s exact shape: the API stamps it when the user presses the offer, the
  // worker consumes it at the top of the mailbox's serial cycle — runs `junkSweepPass` under the
  // organizer lease, then clears ONLY the value it observed — and NULL is "no sweep owed". A
  // stamp the WORKER serves rather than a move the API performs: the sweep is user-commanded but
  // is a bulk organization act over mirrored rows, and those the API never applies itself. The
  // offer's visibility is the CANDIDATE COUNT (mail still physically in `ohmail/Quarantine`), so
  // "never offered twice" needs no second column — a swept pile has no candidates, and a pile
  // that grows again is offered again honestly.
  junkSweepRequestedAt: integer("junk_sweep_requested_at", { mode: "timestamp_ms" }),
  // Mail 0078 — the forwarding-detection notice's two columns. Born from an incident: a
  // provider-level forward diverted every inbound mail before IMAP storage for weeks — the
  // product was healthy and said nothing. `inboundQuietSince` is EVIDENCE, owned by the worker's
  // inbound-quiet pass: when a connected, fully-imported mailbox's GENUINE inbound (From not its
  // own address) has been zero for the generous window while evidence says mail should arrive,
  // the pass stamps the newest genuine inbound date. NULL is "no quiet episode"; COALESCED for
  // the episode's life, cleared only when genuine inbound RESUMES — several arrivals, so one
  // stray mail neither ends an episode nor re-arms the notice. `inboundQuietDismissedAt` is the
  // user's dismissal; the worker never clears it, and the client shows the notice only while
  // `dismissedAt < since` — an undisturbed episode never re-notifies, a NEW one does.
  inboundQuietSince: integer("inbound_quiet_since", { mode: "timestamp_ms" }),
  inboundQuietDismissedAt: integer("inbound_quiet_dismissed_at", { mode: "timestamp_ms" }),
  // Mail 0029 — WHY a `connected` mailbox is not being synced. The stretch of time a user spent
  // looking at a spinner while the worker knew what was wrong and wrote it ONLY TO A LOG: three
  // branches declined to serve an expected mailbox and left the row pristine
  // (`LeaseUnavailableError`, `awaitingCreds`, the `maxMailboxes` cap). A CLOSED set with a CHECK
  // (`MAILBOX_SYNC_BLOCK_REASONS`): these are the ways OUR OWN infrastructure declines,
  // enumerable by reading the worker. No `no_organizer` member — read the constant's header
  // before adding one. Orthogonal to `status`, which stays `connected`: an `error_code` value is
  // invisible on the wire, a fourth status value breaks the webapp, and the fleet's liveness
  // table cannot answer a per-mailbox question. Not a failure, not a disable: no `error_code`, no
  // backoff; every writer that makes the statement untrue clears BOTH columns in one statement.
  syncBlockedReason: text("sync_blocked_reason"),
  // When the CURRENT block began — `coalesce(sync_blocked_since, now)` on write, exactly as
  // `failed_at` does, so a mailbox blocked for three days reports three days instead of "just
  // now, again" on every roster pass.
  syncBlockedSince: integer("sync_blocked_since", { mode: "timestamp_ms" }),
  // Mail 0049 — enforced sync: "the mailbox owes a reconcile RIGHT NOW", set by the API. The
  // worker's rhythm is a 60 s poll plus IDLE — fine for arriving mail, too slow for a change the
  // USER just made and is watching for: a send whose Sent copy must appear, a move the mirror
  // should reflect. The API stamps this the instant it finalizes such a write; the worker's ~3 s
  // kick scan (`sync-kick.ts`) picks up any stamped mailbox IT SERVES, triggers an out-of-band
  // cycle, and clears the stamp. NULL is the resting state. A REQUEST, not a schedule, and the
  // clear is compare-and-clear: the kick clears ONLY the exact value it observed, so a second
  // stamp landing while the kick runs is not lost — the clear misses and the next scan re-kicks;
  // a burst collapses to at most one extra cycle. Only the API writes it and only the worker
  // clears it; a deploy in either order is safe.
  syncRequestedAt: integer("sync_requested_at", { mode: "timestamp_ms" }),
  // Mail 0055 — what the sending server said it will accept (RFC 1870 `SIZE`). The attachment
  // ceiling used to be one product constant reasoned from the HOSTED API's request-body limit —
  // no fact about a LOCAL install, which hands the message straight to SMTP: it refused
  // attachments the user's own server would have taken. This is the number that governs: the
  // ceiling the submission server announces in its EHLO reply, written by the connect-time SMTP
  // probe. NULL is "not known", read as the STRICT answer: no `SIZE`, bare `SIZE`, and `SIZE 0`
  // all answer "none that I stated", and `SendService` resolves unknown to the product's own 3 MB
  // rather than "unbounded" — an unknown limit read as no limit is a message the user composes
  // and has bounced. `bigint`, not `integer`: the value is an unbounded decimal in somebody
  // else's reply, and an announcement above 2^31 must be storable rather than raise 22003.
  smtpMaxSizeBytes: integer("smtp_max_size_bytes"),
  // Mail 0063 — when the `SIZE` back-fill last asked, and what it heard. The pair that turns the
  // back-fill's selection into a backoff: the column above stays NULL for three outcomes that are
  // not failures (no `SIZE` advertised, a refused login, nothing to dial), so a selection keyed
  // on `IS NULL` alone re-picked exactly those rows on every run, forever — a permanently silent
  // server cost a real login a day. NOT a terminal state: `smtp_size_probed_at` is when we last
  // asked, `smtp_size_probe_code` what came back, and the pass re-asks on an interval chosen from
  // the code (a month for answered-and-named-nothing, a week otherwise). Only the API host writes
  // these: the sync host's platform blocks outbound submission, so a stamp from there would
  // record `unreachable` for every mailbox. The code carries a CHECK (`SMTP_SIZE_PROBE_CODES`):
  // the value derives from an SMTP AUTH failure — a server's own text can echo the credential.
  smtpSizeProbedAt: integer("smtp_size_probed_at", { mode: "timestamp_ms" }),
  smtpSizeProbeCode: text("smtp_size_probe_code"),
  // Mail 0030 — the one-time re-evaluation of mail the sensitivity override already misrouted. A
  // fix stopped a sender-chosen subject or body carrying a stranger past the consent gate; it is
  // forward-looking only, and the damage was already filed — most of the measured Ohbox rows were
  // sensitive and nearly all came from senders absent from `contacts`. This column is the
  // correction's idempotency: NULL means "never re-screened", a timestamp "done, never again". A
  // MARKER, stamped AFTER the pass, never before: claiming it first would make a crash permanent.
  // Re-running is safe without it — the candidate query is the idempotency (a moved message is no
  // longer a candidate); the marker saves the scan, not the correctness. NOT `kickstart_at`
  // re-used: `listScreenerBacklog` selects the INVERSE candidate set, and that marker is already
  // stamped on every live mailbox.
  sensitiveRescreenAt: integer("sensitive_rescreen_at", { mode: "timestamp_ms" }),
  /**
   * Where the re-screen got to — the last `messages.id` of the last COMMITTED page (mail 0081).
   * The marker says whether the pass is FINISHED; this says where it is. The pass is bounded, and
   * without a resume point the next run started at the beginning: MOVERS drop out of the
   * candidate query, STAYERS do not, so a prefix of stayers was re-read forever. Same column,
   * same reason as `rules.retro_cursor`. Written inside the page's own transaction; advanced
   * under `WHERE cursor IS NULL OR cursor < <new>` so two operators cannot rewind one another;
   * NULLed in the same UPDATE that stamps the marker. Known limit: an exclusion REMOVED mid-pass
   * is invisible — the remedy is to NULL all three re-screen columns together.
   */
  sensitiveRescreenCursor: text("sensitive_rescreen_cursor"),
  /**
   * When the walk that cursor belongs to BEGAN — the window the completion check looks back over
   * (mail 0081). NULL exactly when the cursor is NULL. The check needs the WALK's start, not the
   * RUN's: the cursor outlives an invocation — run A stores a prefix and exits, the worker
   * restores one of A's rows to the Ohbox, run B resumes past it. Against B's own start that
   * restoration is invisible, and B stamps; against the WALK's start it is inside the window, B
   * declines the marker and clears both columns, so the next run re-walks the prefix. Written
   * with `coalesce(existing, <run start>)` in the same guarded UPDATE as the cursor; cleared with
   * the cursor when the marker lands.
   */
  sensitiveRescreenStartedAt: integer("sensitive_rescreen_started_at", { mode: "timestamp_ms" }),
  // Mail 0036 — the one-time repair of bodies a classifier FALSE POSITIVE stored redacted. A
  // click tracker's percent-escaped slash (`-2F`) put word boundaries around `2Fa`, read as the
  // acronym `2fa`; mail judged sensitive is stored with text redacted and NO HTML, so ordinary
  // newsletters were filed unreadable. The fix (`proseOnly`) is forward-looking; the only
  // remaining copy of the discarded HTML is on the IMAP server. A MARKER, for the reason
  // `thread-backfill` needed none: THIS candidate set does not shrink — a message still sensitive
  // under the fixed classifier is a candidate forever, so without a marker the pass would re-read
  // every categorised message off the server every cycle. Stamped AFTER the pass (claiming first
  // makes a crash permanent); re-running is safe — the marker saves the IMAP reads, not the
  // correctness. NULLing it asks again.
  sensitiveFpBackfillAt: integer("sensitive_fp_backfill_at", { mode: "timestamp_ms" }),
  // Mail 0038 — when this mailbox's FIRST IMPORT actually finished. A first import drains
  // newest-first in bounded batches, so the server holds a PARTIAL mailbox for the whole of it.
  // The client watches its own mirror grow and says "still syncing"; what it could not see is the
  // import ENDING for a reason other than completion, so a tab that caught up called the mailbox
  // done and showed a Screener with a hole in it as the whole of it. NOT `last_sync_at`: that
  // column is SHARED (one UPDATE per cycle) and lands EARLY (after every successful cycle,
  // backlog or not). This one is PER-MAILBOX, written ONLY once a cycle completes with
  // `hasBacklog === false`. The client reads it as a FLOOR: `IS NULL` means still importing.
  // Guarded on `IS NULL` so it is a once-per-mailbox event; clearing it back to NULL is the
  // supported way to make the client speak "still importing" again.
  initialImportCompletedAt: integer("initial_import_completed_at", { mode: "timestamp_ms" }),
  // Mail 0098: the HTML signature beside the text one. Nullable, same as its twin.
  signatureHtml: text("signature_html"),
}, (t) => ({
  // ONE ACTIVE MAILBOX PER ADDRESS (mail 0021). PARTIAL, because `delete` is a soft delete to
  // `status='disabled'` and a plain unique would make reconnecting a disconnected address fail
  // forever against its own tombstone. On `lower(address)` because nothing normalizes this
  // column on write and it doubles as the default IMAP username, so it must not be lowercased
  // in place. Declared here only to keep the TS schema honest — the index is created by the
  // migration, and a test diffs this declaration against the real catalog.
  uqActiveAddress: uniqueIndex("mailboxes_active_address_uq")
    .on(t.accountId, sql`lower(${t.address})`)
    .where(sql`${t.status} <> 'disabled'`),
  // THE CLOSED SET, AT REST (mail 0027). The members are `MAILBOX_DISABLED_REASONS`
  // (mailbox-errors.ts) and the two are reconciled by a test against real Postgres, which
  // inserts every member and one foreign string and watches the constraint refuse the last one.
  // Declared here to keep the TS schema honest; the constraint is created by the migration.
  ckDisabledReason: check(
    "mailboxes_disabled_reason_closed",
    sql`${t.disabledReason} is null or ${t.disabledReason} in ('organized_elsewhere:cloud', 'organized_elsewhere:local', 'organized_elsewhere:mobile', 'organized_elsewhere:unknown')`,
  ),
  // THE SECOND CLOSED SET, AT REST (mail 0029). Members are `MAILBOX_SYNC_BLOCK_REASONS`, and a
  // Postgres test reconciles the two the way the set above is reconciled: insert every member plus
  // one foreign string, and watch the CHECK refuse the last. Declared here to keep the TS schema
  // honest; the constraint is created by the migration.
  ckSyncBlockedReason: check(
    "mailboxes_sync_blocked_reason_closed",
    sql`${t.syncBlockedReason} is null or ${t.syncBlockedReason} in ('lease_unreadable', 'awaiting_credentials', 'at_capacity', 'read_limited')`,
  ),
  // THE THIRD AND FOURTH CLOSED SETS . `organizerRole` has no `is null` arm because
  // the column is NOT NULL — the set really is two members, and spelling a third state that
  // cannot exist would invite a reader to handle it. Members are `ORGANIZER_ROLES` and
  // `ORGANIZER_KINDS` (organizer-role.ts); a real-Postgres test reconciles each against its
  // constraint the way 0027's and 0029's are reconciled. Declared here to keep the TS schema
  // honest; both constraints are created by the migration.
  ckOrganizerRole: check(
    "mailboxes_organizer_role_closed",
    sql`${t.organizerRole} in ('organizer', 'reader')`,
  ),
  ckOrganizedByKind: check(
    "mailboxes_organized_by_kind_closed",
    sql`${t.organizedByKind} is null or ${t.organizedByKind} in ('cloud', 'local', 'mobile', 'unknown')`,
  ),
  // THE FIFTH . `organizerState` is the lease's occupancy as a reader cycle last saw
  // it; NULL is "we have not looked", which is every row until its first cycle.
  ckOrganizerState: check(
    "mailboxes_organizer_state_closed",
    sql`${t.organizerState} is null or ${t.organizerState} in ('held', 'stopped')`,
  ),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0007 — per-mailbox, per-transport credentials, ALWAYS
// envelope-encrypted at rest. The PK is composite `(mailbox_id, transport)`
// because ONE generic IMAP mailbox needs BOTH an 'imap' and an 'smtp' row (and
// Exchange a single 'graph' row) — a per-mailbox scalar PK could not hold both.
// `secret_enc` is TEXT (KeyProvider emits a base64url string, and the hosted
// second-factor store's encrypted column is TEXT for the same reason — NOT
// bytea). `meta` holds NON-secret connection
// params only (host/port/user/secure). NEVER surfaced by any DTO/route.
// ─────────────────────────────────────────────────────────────────────────────
export const mailboxCredentials = sqliteTable("mailbox_credentials", {
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id),
  transport: text("transport").notNull(),                                  // 'imap'|'smtp'|'graph'
  secretEnc: text("secret_enc").notNull(),                                 // envelope-encrypted, base64url
  keyVersion: integer("key_version").notNull(),                            // KeyProvider KEK version
  meta: text("meta", { mode: "json" }),                                                     // non-secret conn params (host/port/user/secure)
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.mailboxId, t.transport] }) }));

export const mailboxFolders = sqliteTable("mailbox_folders", {
  id: text("id").default(UUID_V4).primaryKey(),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id),
  folder: text("folder").notNull(),
  uidvalidity: int64("uidvalidity"),
  uidnext: int64("uidnext"),
  highestmodseq: int64("highestmodseq"),
  deltaToken: text("delta_token"),
  /**
   * The folder's `EXISTS`, as the SELECT reported it — the first pull's denominator. No truthful
   * total existed anywhere: this table held cursors only, and the adapter read `mb.exists` off
   * every SELECT and discarded it, so the import progress strip had a numerator (the mirror's row
   * count) and nothing to divide it by — the one number ever shown was a literal multiplier
   * somebody guessed. Remaining is the sum of this column over WATCHED folders minus the mirror
   * count; the ETA is remaining/rate, said as "about", and gone at `initialImportCompletedAt`.
   * Written by every cycle that opens the folder; NULL means "not yet opened under this build" —
   * never zero. A reader writes it exactly like an organizer: counting is a read.
   */
  serverExists: integer("server_exists"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ uq: unique().on(t.mailboxId, t.folder) }));

  /**
   * The folder's `EXISTS`, as the SELECT reported it — the first pull's denominator. No truthful
   * total existed anywhere: this table held cursors only, and the adapter read `mb.exists` off
   * every SELECT and discarded it, so the progress strip had a numerator and nothing to divide it
   * by — the one number shown was a literal multiplier somebody guessed. Remaining is the sum of
   * this column over WATCHED folders minus the mirror count; the ETA is said as "about" and gone
   * at `initialImportCompletedAt`. Written by every cycle that opens the folder; NULL means "not
   * yet opened under this build" — never zero. A reader writes it exactly like an organizer:
   * counting is a read.
   */
export const folderOps = sqliteTable("folder_ops", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id),
  folderId: text("folder_id").notNull().references(() => mailboxFolders.id, { onDelete: "cascade" }),
  op: text("op").notNull(),           // 'create' | 'rename' | 'delete' — CHECK-closed (0074)
  toFolder: text("to_folder"),        // rename target; NULL otherwise — CHECK-paired (0074)
  status: text("status").notNull().default("pending"), // 'pending' | 'failed' — CHECK-closed
  /** Closed refusal code when `status = 'failed'` — a catalogue key, never provider text. */
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  requestedAt: integer("requested_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ uqFolder: unique().on(t.folderId) }));

export const messages = sqliteTable("messages", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id),
  messageIdHeader: text("message_id_header"),
  bodyHash: text("body_hash").notNull(),
  dedupKey: text("dedup_key").notNull(),
  subject: text("subject").notNull().default(""),
  fromAddress: text("from_address").notNull().default(""),
  /**
   * The From header's DISPLAY NAME, as the sender wrote it (mail 0057). NULL is both "the header
   * carried no name" and "ingested before the column existed" — deliberately indistinct, because
   * the reader falls back to the address either way. The recipients' names live inside the
   * `to_addresses`/`cc_addresses` jsonb pairs; this is the sender's half, kept as its own column
   * because `from_address` is indexed three ways and the pair is reassembled at the DTO boundary
   * (`materialize.ts`), not stored.
   */
  fromName: text("from_name"),
  date: integer("date", { mode: "timestamp_ms" }),
  nativeLocator: text("native_locator", { mode: "json" }),     // { folder, ref }
  noAi: integer("no_ai", { mode: "boolean" }).notNull().default(false),
  noForward: integer("no_forward", { mode: "boolean" }).notNull().default(false),
  noKb: integer("no_kb", { mode: "boolean" }).notNull().default(false),
  priority: integer("priority", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  // ── API display fields + threading (materialized into MessageDTO) ──
  threadId: text("thread_id").references(() => threads.id),
  unread: integer("unread", { mode: "boolean" }).notNull().default(true),
  /**
   * When this message stopped being unread — the order "Earlier" is sorted by (mail 0047).
   * Written by the same statement that flips {@link unread}: an instant when the flag goes false,
   * NULL when it goes back to true. A record OF the flag, never its source. NULL means "not
   * known" and must sort BELOW every stamped row: two different rows carry NULL — read before
   * this column existed, and never read at all — and neither has an honest answer. No backfill
   * for the same reason: substituting `updated_at` or `date` would hand the reader a manufactured
   * order they cannot tell from a real one. No index; the sort happens on the client, and the
   * server's keyset stays `(date, id)`.
   */
  lastReadAt: integer("last_read_at", { mode: "timestamp_ms" }),
  /**
   * Mail 0065 — when this message left the mirror's living views. Two writers, one meaning: the
   * user DELETED it (it rides to the provider's Trash), or the worker observed it EXPUNGED from
   * every watched folder. Both emit a `change_log` `delete`, so every client tombstones the row.
   * A TIMESTAMP and not a row delete: the row is the message's identity — `dedup_key` recognises
   * the same message if it re-appears, and `change_log`/`message_instances`/threads reference it.
   * The re-appearance path clears this and re-emits the entity — "a LATER create resurrects".
   * Every living-view read excludes `deleted_at IS NOT NULL`; GET-by-id deliberately still
   * answers, for idempotent replay.
   */
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  snippet: text("snippet").notNull().default(""),          // sensitivity-redacted preview (never an OTP)
  toAddresses: text("to_addresses", { mode: "json" }).notNull().default(sql`'[]'`),   // EmailAddress[]
  ccAddresses: text("cc_addresses", { mode: "json" }).notNull().default(sql`'[]'`),   // EmailAddress[]
  hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull().default(false),
  attachmentCount: integer("attachment_count").notNull().default(0),
  sensitivityCategory: text("sensitivity_category"),      // SensitivityResult.category surfaced in the DTO
  /**
   * The offline DKIM verdict for the CLAIMED author — column added by mail 0028, wired later,
   * deliberately: wiring it then needs no DDL and no deploy-ordering exercise. When wired, the
   * union is `aligned | signed_unaligned | unsigned | fail | temperror | unavailable`, computed
   * from `change.raw` plus a DNS TXT lookup of the selector — never from a header anyone wrote.
   * NULL resolves to the PERMISSIVE value, and that is a rule about consent: every row predating
   * the wiring was decided under the old rules, and a missing verdict failing closed would put
   * previously-accepted senders back in the Screener — the one outcome a deploy is rolled back
   * for. No CHECK, on 0023's rule: the vocabulary belongs to the code that computes it.
   */
  authVerdict: text("auth_verdict"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  uqDedup: unique().on(t.mailboxId, t.dedupKey),
  ixThread: index("messages_account_thread_idx").on(t.accountId, t.threadId),
  // ── Mail 0026 — the THREADING key ──
  // `resolveThread` looks a parent up by `WHERE account_id = $1 AND message_id_header = ANY($2)`
  // — the whole of the key, since threading is header-chain-only with no subject fallback.
  // There was no index on this column at all, so every parent lookup was a sequential scan and
  // the backfill over a large mailbox's rows was quadratic. `account_id` LEADS deliberately: a
  // Message-ID is attacker-choosable (anybody can send you mail carrying one), so the account
  // has to be the first key rather than a filter applied to a cross-account result.
  ixMessageIdHeader: index("messages_account_message_id_header_idx").on(t.accountId, t.messageIdHeader),
  ixUnread: index("messages_account_mailbox_unread_idx").on(t.accountId, t.mailboxId, t.unread),
  // Mail 0034 — WHO sent it, which nothing could look up. There was no index on `from_address` at
  // all, so every reader — the retro pass, the re-screen's candidate query, `heldRowsForDomain` —
  // was a sequential scan over the account's messages, and the retro pass runs one PER PAGE, per
  // cycle, per owed rule. `lower(from_address)`, not the raw column: every writer and reader of
  // an address in this tree case-folds, so an index on the raw column would be unusable by all of
  // them. `id` is the third column so the pass's `ORDER BY messages.id` keyset page is served by
  // the same index rather than a sort. `account_id` LEADS: a sender address is
  // attacker-choosable, so the account is the first key and never a filter applied to a
  // cross-account result.
  ixFromAddress: index("messages_account_from_addr_idx")
    .on(t.accountId, sql`lower(${t.fromAddress})`, t.id),
  // A SECOND index and not a range scan on the one above, BECAUSE A SUFFIX IS NOT A PREFIX.
  // Addresses at one domain differ in their local part, which sorts first, so they are scattered
  // through `lower(from_address)` rather than adjacent in it; and `like '%@corp.com'` can use no
  // index at all AND matches `evil-corp.com`. FIRST-@ semantics, matching `domainOf` on the
  // client and `heldRowsForDomain` on the server — deliberately not `split_part(…, '@', 2)`,
  // which disagrees on an address holding two `@`. The mail a rule MOVES must be the set the
  // sheet PREVIEWED. Every function here is IMMUTABLE, which is what makes it indexable.
  ixFromDomain: index("messages_account_from_domain_idx").on(
    t.accountId,
    sql`substr(lower(${t.fromAddress}), instr(lower(${t.fromAddress}), '@') + 1)`,
    t.id,
  ),
}));

/**
 * Physical identity — every locator one LOGICAL message occupies (mail 0028). `native_locator`
 * names exactly one place, and a message legitimately occupies several: the Sent twin of a
 * self-CC, a list echo, and — the case this table exists for — a SECOND DELIVERY of the same
 * bytes; every other locator was an unknown UID, fetched and declined every cycle. UNIQUE
 * (mailbox, folder, uidvalidity, uid): a UID means nothing outside its epoch. UNIQUE (message_id)
 * WHERE is_primary: one instance mirrors `native_locator`. A row means "this locator is on the
 * server"; absence is the row being gone, written only by the worker consuming the adapter's
 * `deletes` — only the user can make a stored locator disappear.
 */
export const messageInstances = sqliteTable("message_instances", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id),
  messageId: text("message_id").notNull().references(() => messages.id),
  folder: text("folder").notNull(),
  uidvalidity: int64("uidvalidity").notNull(),
  uid: integer("uid").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  uqLocator: unique("message_instances_locator_uq").on(t.mailboxId, t.folder, t.uidvalidity, t.uid),
  ixMessage: index("message_instances_message_idx").on(t.messageId),
  // The partial unique on `(message_id) WHERE is_primary` is created BY THE MIGRATION, not here:
  // drizzle's `unique()` has no partial form, and a non-partial unique on `message_id` would
  // refuse the second instance this table exists to hold. A Postgres test asserts that the second
  // instance is accepted while a second PRIMARY is refused, and the catalog diff pins the index
  // the migration created.
}));

/**
 * One message the sync loop could not ingest — durable, content-free, retried by UID. The
 * in-memory ledger moves past a failure; the SENT folder's cursor is a UID WATERMARK, so a
 * skipped UID the watermark crossed is never enumerated again — and `own_copy` mail produces no
 * `messages` row, so nothing else notices: a message the user sent left their view permanently.
 * No subject, sender, Message-ID, bytes or free text: a row is a COORDINATE plus a closed `code`.
 * NEVER granted to the admin console's role: the information is in the row's EXISTENCE, so no
 * projection closes it. The due predicate's version arm makes a deploy carrying a parser fix
 * reach the mail it fixes — self-disarming, once per build.
 */
export const messageFailures = sqliteTable("message_failures", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id),
  folder: text("folder").notNull(),
  uidvalidity: int64("uidvalidity").notNull(),
  uid: integer("uid").notNull(),
  /** `MessageFailureCode`. A CHECK in the migration closes the set — see the file's header. */
  code: text("code").notNull(),
  attempts: integer("attempts").notNull().default(0),
  /** The build that last attempted this UID. `IS DISTINCT FROM` the running one ⇒ due. */
  attemptedVersion: text("attempted_version"),
  firstFailedAt: integer("first_failed_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  lastFailedAt: integer("last_failed_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  /** NULL ⇒ no CLOCK-scheduled retry. The version arm still applies. */
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
  /** Ingested, or gone from the server, or void under a new epoch. History from here on. */
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
}, (t) => ({
  uqLocator: unique("message_failures_locator_uq").on(t.mailboxId, t.folder, t.uidvalidity, t.uid),
  // The PARTIAL `(mailbox_id, next_attempt_at) WHERE resolved_at IS NULL` retry probe is created BY
  // THE MIGRATION: drizzle's `index()` has no partial form, and a non-partial index would make
  // every cycle walk the whole resolved history of the account.
}));

/**
 * The reconcile backoff pair, on BOTH desired-state tables (mail 0058). When the server refuses
 * one particular mutation, retrying it every cycle costs a round trip forever — and the pending
 * queue is oldest-first under a fixed budget, so immortal rows collect at the HEAD and consume
 * the whole allowance: mail filed a minute ago never reaches the server. The queue must be able
 * to SKIP a row. `attempts` counts refusals; `next_attempt_at` is when to try again — NULL is DUE
 * NOW, what every row is born as and reset to on fresh intent. The row is never dropped: no "gave
 * up" state — a user's move is their state. No error column: what went wrong is free text from
 * someone else's server and belongs in the audit row.
 */
export const folderState = sqliteTable("folder_state", {
  id: text("id").default(UUID_V4).primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id),
  desiredFolder: text("desired_folder").notNull(),
  observedFolder: text("observed_folder").notNull(),
  lastSetBy: text("last_set_by").notNull(),   // 'us' | 'external'
  reconcileStatus: text("reconcile_status").notNull().default("pending"),
  conflict: integer("conflict", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  /** Refusals recorded for this move. See the block above. */
  attempts: integer("attempts").notNull().default(0),
  /** NULL ⇒ due now. See the block above. */
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
  // Mail 0097: the class of the last refusal, closed to the same four words as the server.
  lastErrorClass: text("last_error_class"),
  // Mail 0099: the pile a trashed message came from, so an untrash knows where to put it back.
  trashedFrom: text("trashed_from"),
}, (t) => ({ uqMessage: unique().on(t.messageId) }));

/**
 * Read-state desired state — `folder_state` for the `\Seen` flag (mail 0024): the API may never
 * open IMAP, so a client that marks mail read writes what it WANTS and the worker puts it on the
 * server. The old PATCH wrote `messages.unread` and stopped — the flag never reached the mailbox,
 * and mail read for years came back "New" on first sync. `desired_seen` is what the user asked;
 * `observed_seen` what the server last said (worker-only); `last_set_by` — the reconciler refuses
 * to push a row it did not author, the user-wins rule; `reconcile_status` is DERIVED at every
 * write, so a row cannot claim convergence it does not have. One row per message.
 * `messages.unread` stays the READ model; this is the write intent behind it.
 */
export const flagState = sqliteTable("flag_state", {
  id: text("id").default(UUID_V4).primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id),
  desiredSeen: integer("desired_seen", { mode: "boolean" }).notNull(),
  observedSeen: integer("observed_seen", { mode: "boolean" }).notNull(),
  lastSetBy: text("last_set_by").notNull(),   // 'us' | 'external'
  reconcileStatus: text("reconcile_status").notNull().default("pending"),
  conflict: integer("conflict", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  /** Refusals recorded for this `\Seen` write — `folder_state`'s pair, same rules. */
  attempts: integer("attempts").notNull().default(0),
  /** NULL ⇒ due now. See the block above `folderState`. */
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
}, (t) => ({ uqMessage: unique().on(t.messageId) }));

export const rules = sqliteTable("rules", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  kind: text("kind").notNull(),               // 'sender' | 'domain' | 'header'
  match: text("match").notNull(),
  destination: text("destination").notNull(), // one of the six canonical folders
  priority: integer("priority").notNull().default(0),
  provenance: text("provenance").notNull().default("manual"), // manual | migrated | promoted
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  // ── RuleDTO.stats ──
  hits: integer("hits").notNull().default(0),
  lastHitAt: integer("last_hit_at", { mode: "timestamp_ms" }),
  demotions: integer("demotions").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),

  // Mail 0034 — applying a rule to mail that is ALREADY filed. The default: creating a rule
  // applies it to all messages, future and previous. `retro_requested_at` set with
  // `retro_done_at` NULL is the ONE definition of owed work. `retro_done_at` is written LAST
  // (claiming first makes a crash permanent); re-running is safe because the candidate query is
  // the idempotency. `retro_cursor` is the resume point — ACCOUNT-scoped (a rule's scope is the
  // account). Known limit: `messages.id` is a random UUID, monotone only within one run's
  // ordering, so a message ingested after the cursor passed its id is skipped forever —
  // acceptable, since a rule routes new mail at arrival. `retro_moved` is reported, not read.
  // These columns ship to the desktop engine where nothing writes them yet — deliberate
  // (`messages.auth_verdict` landed the same way).
  retroRequestedAt: integer("retro_requested_at", { mode: "timestamp_ms" }),
  retroDoneAt: integer("retro_done_at", { mode: "timestamp_ms" }),
  retroCursor: text("retro_cursor"),
  retroMoved: integer("retro_moved").notNull().default(0),

  // Mail 0050 — a second term on a sender rule: the SUBJECT. One sender sends two kinds of mail
  // (`info@` is the invoice AND the nightly alert), and a sender rule could only file all of it
  // together. NULL is the resting state, "no subject term"; there is no backfill and can never be
  // one: a term invented for an existing rule would NARROW a decision the user made about a whole
  // sender. A CONJUNCTION: `matches` reads it as an extra term, so a present term can only make a
  // rule fire LESS often, and an older engine reading a newer database keeps matching on the
  // sender alone. It changes the ORDER: a subject-carrying rule OUTRANKS a bare rule for the same
  // address — the more specific statement has to win. The CHECK forbids empty and whitespace-only
  // (one representation of "no term"); the 200-char ceiling refuses a haystack as a needle.
  subjectContains: text("subject_contains"),

  // Mail 0052 — the other half of the same requirement: the MESSAGE TEXT. Some senders write the
  // SAME subject on every message and put the distinguishing text in the body; this is the same
  // conjunction one field deeper. Everything the 0050 comment says holds unchanged: NULL is the
  // resting state, no backfill ever, `matches` reads it as an extra term, the CHECK makes NULL
  // the only spelling of "no term". The one new decision is the haystack: the message's canonical
  // PLAIN TEXT — `NormalizedMessage.textBody` on arrival, byte-identical to
  // `message_bodies.text`, which the retro passes read back, so arrival and retro consult the
  // SAME haystack. A body not on disk reads as `""`, which satisfies no term — fail-closed for a
  // narrowing conjunct. Rank: both terms, then subject-only, then body-only, then bare. Same
  // 200-char ceiling.
  bodyContains: text("body_contains"),
}, (t) => ({
  /**
   * The owed-work probe, run once per account per worker cycle. Without it that is a full scan
   * of `rules` on every cycle for every account; partial, so the index holds only the rules that
   * are actually owed — which is zero rows in the steady state.
   */
  ixRetroOwed: index("rules_retro_owed_idx").on(t.accountId)
    .where(sql`${t.retroRequestedAt} is not null and ${t.retroDoneAt} is null`),
}));

export const contacts = sqliteTable("contacts", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  address: text("address").notNull(),         // lowercased sender address = "known sender"
  // ── Migration 0010: user-editable display name for the reference
  // card (PATCH /contacts/:id { name }). Nullable — a contact begins as a bare
  // address the pipeline recorded; the user may later name it. ──
  name: text("name"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ uq: unique().on(t.accountId, t.address) }));

export const auditLog = sqliteTable("audit_log", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  action: text("action").notNull(),
  payload: text("payload", { mode: "json" }),
  inverse: text("inverse", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Delta change-log. The single mechanism every client-visible
// mutation writes to. Per-account monotonic, gap-free `seq` allocated from a
// counter row locked inside each mutation's transaction.
// ─────────────────────────────────────────────────────────────────────────────

export const accountSyncState = sqliteTable("account_sync_state", {
  accountId: text("account_id").primaryKey(),           // one row per account; the seq source of truth
  nextSeq: int64("next_seq").notNull().default(sql`0`),
});

export const changeLog = sqliteTable("change_log", {
  accountId: text("account_id").notNull(),
  seq: int64("seq").notNull(),     // assigned via allocateSeq(tx, accountId); PART OF PK
  entityType: text("entity_type").notNull(),            // EntityType (message|thread|routing_decision|approval|…)
  entityId: text("entity_id").notNull(),
  op: text("op").notNull(),                             // create|update|move|delete
  meta: text("meta", { mode: "json" }),                                  // move: {from,to}; else null
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.accountId, t.seq] }),    // covers the `WHERE account_id=$ AND seq>$ ORDER BY seq` scan
  /**
   * THE OHBOX-TIDY USER-WINS PROBE (mail 0043). The backlog re-route pass excludes any message the
   * user has ever moved back INTO the Ohbox — an in-app drag writes exactly this row
   * (`message-service.ts#move`), and it is the only durable record of that intent that survives
   * every prune (the change log never is). Without this partial index that `NOT EXISTS` is a full
   * scan of the account's whole change log PER CANDIDATE, per page, and the failure mode is a
   * worker cycle that quietly stops finishing — the SILENT class `SCHEMA_INDEX_MARKERS` exists for.
   * Partial on `op='move' AND meta->>'to'='INBOX'`, so it holds only the move-to-Ohbox rows.
   */
  ixMoveToInbox: index("change_log_move_to_inbox_idx").on(t.accountId, t.entityId)
    .where(sql`${t.op} = 'move' and ${t.meta} ->> 'to' = 'INBOX'`),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Threads & bodies (bodies in a separate 1:1 table)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `classid` half of `pg_advisory_xact_lock(int4, int4)`; the second half is
 * `hashtext(account_id)`. Serializes ACCOUNT ERASURE against the THREAD BACKFILL — the only two
 * writers that lock a whole account's `threads`/`messages` in bulk, in OPPOSITE orders: erasure's
 * DELETE order is forced child-before-parent by the FKs, while the backfill locks an unthreaded
 * `messages` row first because there is no `threads` row yet. Interleaved, a genuine lock cycle.
 * Every OTHER thread writer locks `threads` before `messages` and touches only one message or
 * merge group, so none needs this: the risk is a whole-account sweep meeting the one structurally
 * message-first path.
 */
export const ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS = 420_727_017;

export const threads = sqliteTable("threads", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  subject: text("subject").notNull().default(""),
  participants: text("participants", { mode: "json" }).notNull().default(sql`'[]'`),  // EmailAddress[]
  lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }),
  muted: integer("muted", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  /**
   * The conversation's ROOT Message-ID — the find-or-create conflict anchor (mail 0026). The
   * leftmost (oldest) entry of the arriving message's `References`, else its `In-Reply-To`, else
   * its own Message-ID. Leftmost, not rightmost, is why out-of-order ingest converges: a 4-deep
   * chain arriving as D, B, A, C derives the root from all four, so all four find one row; keyed
   * on the rightmost they would split one conversation into three threads. Before it, `threads`
   * had no natural key and find-or-create was SELECT-then-INSERT — two mailboxes of one account
   * syncing in parallel both miss and both insert. NULL only for a message with no Message-ID at
   * all, and NULLs are DISTINCT in a unique index, so each is its own singleton.
   */
  rootMessageIdHeader: text("root_message_id_header"),
}, (t) => ({
  ix: index("threads_account_last_message_idx").on(t.accountId, t.lastMessageAt),
  // Declared here to keep the TS schema honest; the index is created by mail 0026 and a test
  // diffs this declaration against the real catalog.
  uqRoot: uniqueIndex("threads_account_root_header_uq").on(t.accountId, t.rootMessageIdHeader),
}));

export const messageBodies = sqliteTable("message_bodies", {
  id: text("id").default(UUID_V4).primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id),  // 1:1
  text: text("text").notNull().default(""),             // the FULL original body text (no redaction)
  html: text("html"),
  headers: text("headers", { mode: "json" }).notNull().default(sql`'{}'`),
  loadedRemoteContent: integer("loaded_remote_content", { mode: "boolean" }).notNull().default(false),
  /**
   * Mail 0062: why this row holds no content — the storage cap's honest marker. NULL for every
   * ordinarily stored body. `'storage_cap'` means the body left the hosted store because of the
   * cap — almost always an EVICTED husk. The row keeps real `headers` (the organizing passes read
   * them), and the message on the IMAP server is UNTOUCHED. A marker and not "no row": no-row is
   * indistinguishable from "not yet mirrored"; the DTO must say WHY the text is empty; a future
   * restore is an UPDATE with this as its predicate. Repair passes SKIP non-null rows: withheld
   * is policy, not damage. Mail 0065 adds `'junk_filed'` (written only after the IMAP move
   * landed) and `'expunged'`; an already-withheld row keeps its first reason.
   */
  withheldReason: text("withheld_reason"),
  // ── Migration 0008: the body-text lexical index lives HERE
  // (on `message_bodies`, not `messages`), over the full stored `text`. Bodies are stored
  // unredacted (the mailbox on the server holds them in full anyway), so search reaches all of
  // the reader's own mail. DB-generated; the app never writes it. ──
}, (t) => ({
  uqMessage: unique().on(t.messageId),
  /**
   * THE HUSK-PROVENANCE INDEX (mail 0071). The readers that walk withheld bodies BY REASON — the
   * worker's `junk_filed` convergence pass (`junk-restore.ts` → `listJunkFiledHusks`, once per
   * cycle per mailbox, keyset on `message_id`) and the `storage_cap` restore 0062's comment above
   * names for the future — would otherwise test the marker on every body of the mailbox to find
   * the handful that carry one. PARTIAL on the marker being set, so it holds only the husks and
   * no ordinary body write ever touches it; the reason leads, `message_id` follows so the keyset
   * rides the index order. Its absence is SILENT (`SCHEMA_INDEX_MARKERS` lists it for that).
   */
  ixWithheld: index("message_bodies_withheld_idx").on(t.withheldReason, t.messageId)
    .where(sql`${t.withheldReason} is not null`),
  // ── Mail 0022 — the 256 KiB ceiling on one stored html body ──
  // The tripwire for a storage outage, where mailparser's default `cid:` →
  // `data:…;base64,…` rewriting put hundreds of megabytes of ATTACHMENT bytes in this column and
  // filled the database. Three lines defend it and this is the last: `mime.ts` (`keepCidLinks: true`)
  // stops us manufacturing the bloat, `html-storage.ts` strips what a sender authored and caps
  // the rest, and this makes a regression in either LOUD. Declared here so the ORM's view of
  // the table matches the journal; `0022_message_body_html_cap.sql` carries the full argument.
  ckHtmlCap: check("message_bodies_html_cap", sql`octet_length(${t.html}) <= 262144`),
}));

/**
 * ── Mail 0062: PER-ACCOUNT STORED-BODY BYTES — the managed storage cap's ledger ──────────────
 *
 * One row per account: how many bytes of message-body content (`octet_length(text) +
 * octet_length(html)`) this account holds in `message_bodies`. Maintained in the SAME
 * transaction as every body write — the ingest insert increments it, the two repair passes
 * (`sensitive-backfill`, `redacted-restore`) apply their byte delta, account deletion drops the
 * row — so the number can never describe a state the table is not in.
 *
 * What deliberately does NOT count: `headers` (small, bounded, and still written at cap — a
 * count of undeclinable bytes would grow with no user remedy), `messages.snippet`, drafts,
 * attachment METADATA (attachment bytes are never stored server-side — pulled on demand from
 * IMAP), outbound `attachment_staging` (transient, its own quota), and `body_tsv` (derived).
 * The user-facing sentence is therefore scoped to "mail body storage", never "storage".
 *
 * A maintained counter and not an aggregate because `message_bodies` is the largest table in
 * the database and `sum(octet_length(...))` over it has no index; a MAIL-schema table (not
 * cloud) because the bytes it counts live in the mail schema on every tier. On desktop and
 * self-host it is maintained and read by nothing — the cap is a MANAGED-tier policy wired only
 * in the hosted worker. In the sidecar's cloud-MIRROR mode it is not even maintained: the
 * mirror copies the hosted store, whose authoritative counter is the hosted one, and nothing
 * may ever read the local row there.
 *
 * LOCK ORDER (pinned by `storage-reserve.pg.test.ts`): within any transaction, the
 * `account_storage` row is written BEFORE the first `recordChange`/`allocateSeq` — the ingest
 * path writes bodies before deltas, and the repair passes apply their delta before their
 * `recordChange`, so the two locks are always taken in the same order.
 */
export const accountStorage = sqliteTable("account_storage", {
  accountId: text("account_id").primaryKey(),
  // bigint: a mailbox measured in bytes outruns int4 at 2 GiB, which is an ordinary mailbox.
  bytes: integer("bytes").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  // Declared here so the ORM's view matches the journal; created by mail 0062, which carries
  // the argument. The floor of last resort: no app-side decrement (the repair passes' clamped
  // deltas) can COMMIT a negative byte count.
  ckBytesNonNegative: check("account_storage_bytes_nonneg", sql`${t.bytes} >= 0`),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Routing / approvals / triage. Delta-visible entity tables that
// SyncService re-materializes at read time.
// ─────────────────────────────────────────────────────────────────────────────

export const routingDecisions = sqliteTable("routing_decisions", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  messageId: text("message_id").notNull().references(() => messages.id),
  inputProvenance: text("input_provenance").notNull(),  // 'rule'|'header'|'screener'|'ai'
  matchedRuleId: text("matched_rule_id"),
  destination: text("destination").notNull(),           // a Destination
  confidence: real("confidence"),        // 0..1 (AI) or null (deterministic)
  rationale: text("rationale"),
  spam: integer("spam", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull(),                     // auto_applied|pending_approval|approved|rejected
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ ix: index("routing_decisions_account_message_idx").on(t.accountId, t.messageId) }));

export const approvals = sqliteTable("approvals", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  kind: text("kind").notNull(),                         // 'routing' (current); draft_send / workflow_action (later kinds)
  messageId: text("message_id"),
  routingDecisionId: text("routing_decision_id"),
  action: text("action").notNull(),
  summary: text("summary").notNull().default(""),
  payload: text("payload", { mode: "json" }),                            // executable payload
  confidence: real("confidence"),
  status: text("status").notNull().default("pending"),  // pending|approved|rejected|expired
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ ix: index("approvals_account_status_idx").on(t.accountId, t.status) }));

export const messageStates = sqliteTable("message_states", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  messageId: text("message_id").notNull().references(() => messages.id),
  // none|reply_later|set_aside|bubbled_up|muted|resurfaced. `resurfaced` is NOT a bottom pile —
  // it pins the row at the top of the Ohbox, and it is written both by the worker's bubble-up
  // pass when a schedule comes due and directly by "Resurface now". Free text, no CHECK: the
  // closed set lives in `services/src/dto/types.ts#TriageState`.
  state: text("state").notNull().default("none"),
  // Set for state='bubbled_up' and NULL for every other state, including 'resurfaced' — the
  // worker's due-scan selects on this column, so a date left on a resurfaced row is a second
  // flip waiting to happen.
  bubbleUpAt: integer("bubble_up_at", { mode: "timestamp_ms" }),
  setAt: integer("set_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  uqMessage: unique().on(t.messageId),
  ix: index("message_states_account_state_idx").on(t.accountId, t.state),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Graduation seam. Written by LearningService, READ by the
// pipeline via RoutingPort.isGraduated. A table-level seam — no code cycle.
// Counters are advanced with SQL expressions; the `graduated`
// flip is computed/guarded in SQL, never app-side read-modify-write.
// ─────────────────────────────────────────────────────────────────────────────

export const graduations = sqliteTable("graduations", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  patternKey: text("pattern_key").notNull(),       // e.g. "sender:a@b.com→INBOX" | "domain:b.com→Feed"
  action: text("action").notNull().default("route"),
  positives: integer("positives").notNull().default(0),
  negatives: integer("negatives").notNull().default(0),
  graduated: integer("graduated", { mode: "boolean" }).notNull().default(false),
  graduatedAt: integer("graduated_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ uq: unique().on(t.accountId, t.patternKey, t.action) }));

// ─────────────────────────────────────────────────────────────────────────────
// Learning signals. Every learning-relevant action
// (screener yes/no, approval approve/reject, adopted external move) is captured
// here EXACTLY once, deduped by `triggeringActionId`. The UNIQUE
// (accountId, triggeringActionId) + ON CONFLICT DO NOTHING is the dedup gate:
// a graduation counter is advanced only when a signal is NEWLY inserted, so a
// replayed action never double-counts.
// ─────────────────────────────────────────────────────────────────────────────

export const learningSignals = sqliteTable("learning_signals", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  triggeringActionId: text("triggering_action_id").notNull(),  // "screener:<id>" | "approval:<id>" | "move:<msgId>:<seq>"
  kind: text("kind").notNull(),                                // 'screener'|'approval'|'override'|'external_move'
  senderAddress: text("sender_address"),
  senderDomain: text("sender_domain"),
  destination: text("destination"),                            // a Destination
  label: text("label").notNull(),                              // 'positive'|'negative'
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  uqAction: unique().on(t.accountId, t.triggeringActionId),    // deduped by triggering-action id
  ixAccount: index("learning_signals_account_idx").on(t.accountId),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Accounts & auth / 2FA. Envelope-encrypted TOTP
// secrets, scrypt password hashes, single-use WebAuthn challenges /
// login tokens / OAuth codes / recovery codes, refresh-token families for reuse
// detection, and an auth-throttle/lockout store. None of these tables are
// client-visible `/sync` entities — auth is additive and orthogonal to the
// change-log seam.
// ─────────────────────────────────────────────────────────────────────────────

export const accounts = sqliteTable("accounts", {
  id: text("id").default(UUID_V4).primaryKey(),
  name: text("name").notNull().default(""),
  /**
   * THE AI OFF SWITCH (migration 0022). `false` ⇒ this account spends nothing on AI and
   * calls no model, ever — read by `spendState()` in `ai-gate.ts`, which is the one seam all
   * five AI call sites pass through, so the switch is honoured server-side rather than by any
   * client remembering to ask.
   *
   * Defaults `true`: the switch changes nothing until somebody turns it off. Turning it off is
   * not a plan change — the account keeps its credits and its price, they simply go unspent,
   * and every message is still filed by the deterministic rules.
   */
  aiEnabled: integer("ai_enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * When the AI question was ANSWERED for this account, or NULL for "nobody has been asked"
   * (migration 0084). `accounts.ai_enabled` says whether AI is ON; it cannot say whether anybody
   * was ASKED, because its resting value is `true` and a resting value is indistinguishable from
   * an answer. Onboarding needs both facts — "answered no" and "never asked" select opposite
   * screens — and one boolean cannot carry two independent facts. The measured cost: a fresh
   * hosted account reported `on`, so the AI question was never asked at all, on an account whose
   * AI was already spending its credits. READ AS `IS NOT NULL`, never as a deadline: a skewed
   * clock must not turn it into a different answer.
   */
  aiAnsweredAt: integer("ai_answered_at", { mode: "timestamp_ms" }),
  /**
   * The erasure fence (migration 0079). NULL for every live account; the instant of the account's
   * Art. 17 erasure otherwise — stamped FIRST inside `deleteAccount`'s transaction, with
   * `coalesce` so a retried erasure keeps the first stamp. This row SURVIVES erasure by design
   * (the pseudonymous billing subject), so nothing structural refuses a late writer: without this
   * column, a consent PATCH in flight across the erasure could recreate settings rows a
   * millisecond after the catalog sweep counted zero. Every settings writer opens its transaction
   * by reading this row `FOR SHARE` and refusing on a stamp; the stamp-first order means
   * whichever side wins the row lock, zero rows survive.
   */
  erasedAt: integer("erased_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  email: text("email").notNull(),                 // lowercased at write
  displayName: text("display_name").notNull().default(""),
  /**
   * When this address was proven real and owned by this account (migration 0023). NULL means
   * unproven; both writers `COALESCE`, so verification is monotonic. `AuthService.register`
   * writes it on the INVITE path — the invite is email-BOUND and was mailed to that address, so
   * consuming it inside the account-creating transaction IS the proof (the unbound bootstrap
   * codes are not covered). `AuthService.verifyEmail` writes it on a token mailed to the address
   * PLUS the account password — both halves required. A timestamp, not a boolean: the column
   * answers "how long has this account been able to spend money". Read by `resolveSession`;
   * enforced by `withVerifiedEmail` on checkout and `POST /mailboxes`.
   */
  emailVerifiedAt: integer("email_verified_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  uqEmail: unique().on(t.accountId, t.email),
  /**
   * The login identity, and the only constraint that actually enforces it (migration 0021).
   * `uqEmail` above cannot: `register` inserts a fresh `accounts` row before the `users` row, so
   * no two registrations ever share an `account_id` and the composite is satisfied whatever the
   * address. Before this index the sole guard was an unlocked SELECT-then-INSERT, which two
   * concurrent registrations for one address both pass; `login` then does `where email = $1 limit
   * 1` with no ORDER BY, so the password opens an arbitrary one of the two accounts. Unique, and
   * it REPLACES the old non-unique single-column index, which could only cost writes.
   */
  uqEmailGlobal: uniqueIndex("users_email_unique_idx").on(t.email),
}));

export const devices = sqliteTable("devices", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),                    // 'web' | 'macos'
  label: text("label").notNull().default(""),
  ip: text("ip").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  // mail 0064 — when this device's `/sync` read last reached the horizon (`hasMore: false`).
  // NULL = never completed a drain. Stamped by the API's sync route alone, throttled in the
  // statement; the `device_sync_stale` alert reads it. Never projected into a DTO.
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
}, (t) => ({ ixUser: index("devices_user_idx").on(t.userId) }));

export const sessions = sqliteTable("sessions", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  deviceId: text("device_id").references(() => devices.id),
  familyId: text("family_id").notNull(),           // refresh-token family (reuse detection)
  accessTokenHash: text("access_token_hash"),
  // Privilege scope: 'full' = a completed two-factor login.
  // 'enrollment' = the short-lived password-only session minted at register (or at
  // a re-entry login by a user with ZERO enrolled 2FA methods). It reaches only the
  // `enrollmentOk` routes and is REVOKED the moment a first factor is enrolled.
  // CHECK-constrained to those two values so an unknown scope cannot exist.
  scope: text("scope").default("full").notNull(),
  accessExpiresAt: integer("access_expires_at", { mode: "timestamp_ms" }).notNull(),
  refreshExpiresAt: integer("refresh_expires_at", { mode: "timestamp_ms" }).notNull(),
  lastTwofaAt: integer("last_twofa_at", { mode: "timestamp_ms" }),   // step-up 5-min window
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  // mail 0070 — when this session's `/sync` read last reached the horizon (the empty tail).
  // NULL = never completed a drain. The per-SESSION twin of `devices.last_synced_at` (0064):
  // a deviceless install (the browser-door desktop, a plain web tab) has no device row, so
  // this is the only place its convergence can be recorded. Stamped by the API's sync route
  // alone, throttled in the statement; the `session_sync_stale` alert reads it beside
  // `last_seen_at` (still requesting + not converging = a wedged mirror). Never in a DTO.
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
}, (t) => ({
  ixUser: index("sessions_user_idx").on(t.userId),
  ixFamily: index("sessions_family_idx").on(t.familyId),
  // mail 0080 — THE AUTHENTICATION LOOKUP. `resolveSession` matches on this column on every
  // authenticated request and had no index to match it with: production answered `Seq Scan on
  // sessions` for the real query, over a table that only grows (sessions are marked revoked,
  // never physically reaped) and whose growth any signed-in caller can drive.
  ixAccessToken: index("sessions_access_token_hash_idx").on(t.accessTokenHash),
}));

/**
 * Refresh tokens (mail 0060 — moved from the Cloud half): the rotating-refresh history per
 * session family. A presented token already `consumedAt` is reuse, and the whole family is
 * revoked (`session-lifecycle.ts`). MAIL-half, not by analogy: QR pairing signs a remote device
 * into the desktop-as-host tier, and that device's bearer pair rotates against the store that
 * serves it — the desktop arm runs the mail journal only. What stays private is the identity
 * CEREMONY; a refresh row proves nothing about identity — it is a digest of a credential this
 * same database minted. The hosted database already has this table from cloud 0000; mail 0060
 * creates it guarded, so either journal order converges on one catalog object.
 */
export const refreshTokens = sqliteTable("refresh_tokens", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  familyId: text("family_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  uqToken: unique().on(t.tokenHash),
  ixFamily: index("refresh_tokens_family_idx").on(t.familyId),
  ixSession: index("refresh_tokens_session_idx").on(t.sessionId),
}));

/**
 * Pairing tokens (mail 0059) — the consumable credential behind every pairing ceremony: the
 * standalone server's first-account setup token, a family invite, QR device pairing. MAIL-half: a
 * pairing token is redeemed against the server that will serve the resulting session, and the
 * desktop-as-host arm runs the mail journal only. Not part of the identity ceremony: its whole
 * authority is its own entropy, single-use + TTL. `tokenHash` is sha256 of a ≥128-bit random
 * returned ONCE at mint; redeem is one atomic guarded `UPDATE … RETURNING`, so the row lock
 * decides a race and a token can only be spent as the grant it was minted with. `createdByUserId`
 * is NULL for exactly one mint — the first-boot setup token — and REQUIRED for `device-pair`.
 */
export const pairingTokens = sqliteTable("pairing_tokens", {
  id: text("id").default(UUID_V4).primaryKey(),
  createdByUserId: text("created_by_user_id").references(() => users.id),
  grant: text("grant").notNull(),                  // 'invite' | 'device-pair' (CHECK in 0059)
  tokenHash: text("token_hash").notNull(),         // sha256(raw); the raw value is never at rest
  label: text("label").notNull().default(""),      // device-pair: becomes the device row's label
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  uqToken: unique().on(t.tokenHash),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0006 — HTTP API foundation (additive).
//
// `idempotency_keys` — the atomic idempotency store. The response DTO is
// materialized and this row inserted in the SAME mutation tx, so a
// commit-then-crash can never re-execute the handler: the stored response +
// `seq` are replayed verbatim. PK(account_id, key) is the per-account dedup gate.
// ─────────────────────────────────────────────────────────────────────────────

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  accountId: text("account_id").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),          // sha256(method\npath\nrawBody) hex
  responseStatus: integer("response_status").notNull(),
  responseJson: text("response_json", { mode: "json" }).notNull(),       // the stored response body, replayed verbatim
  seq: integer("seq"),               // change_log seq to re-emit as X-Sync-Seq (null if none)
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),   // created_at + 24h (lazy cleanup)
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.accountId, t.key] }) }));

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0009 — the spy-pixel / tracker blocker's audit trail. One
// row per detected remote-content spy attempt ("who tried to spy on you"):
// the image proxy (GET /img) fetches remote images SERVER-SIDE (hiding the reader's
// IP) and, when the fetched bytes are a 1×1 pixel OR the url/host matches a known
// tracker, records the attempt here. Additive, append-only, account-scoped; NOT a
// `/sync` entity (no change_log wiring) — clients read it via the tracker-events
// feed. `trackerHost`/`url` are nullable (a beacon may carry no resolvable host).
// ─────────────────────────────────────────────────────────────────────────────
export const trackerEvents = sqliteTable("tracker_events", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  messageId: text("message_id").notNull().references(() => messages.id),
  kind: text("kind").notNull(),                    // 'pixel'|'remote_image'|'read_receipt'
  trackerHost: text("tracker_host"),               // who tried to spy (nullable)
  url: text("url"),                                 // the original remote url (nullable)
  detectedAt: integer("detected_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  ixMessage: index("tracker_events_account_message_idx").on(t.accountId, t.messageId),
  ixDetected: index("tracker_events_account_detected_idx").on(t.accountId, t.detectedAt),
}));

// Migration 0010 — reference and compose niceties. Five additive, account-scoped tables served
// purely over REST (no `change_log`/`EntityType` growth — the mailbox/tracker precedent): clients
// refetch rather than sync. `contact_notes`/`thread_notes` are the free-text notes pinned to a
// contact card or a thread (PATCH/DELETE `/notes/:id` resolves an id in either table,
// account-scoped). `snippets` is the compose-time canned-text library. `notify_rules` opts
// specific senders/threads back INTO notifications (off by default). `away_responders` is the
// single per-account autoresponder row (UNIQUE(account_id) means PUT upserts it).

export const contactNotes = sqliteTable("contact_notes", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  contactId: text("contact_id").notNull().references(() => contacts.id),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ ix: index("contact_notes_account_contact_idx").on(t.accountId, t.contactId) }));

export const threadNotes = sqliteTable("thread_notes", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  threadId: text("thread_id").notNull().references(() => threads.id),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ ix: index("thread_notes_account_thread_idx").on(t.accountId, t.threadId) }));

export const snippets = sqliteTable("snippets", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  shortcut: text("shortcut"),                  // optional typeahead trigger (nullable)
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ ix: index("snippets_account_idx").on(t.accountId) }));

export const notifyRules = sqliteTable("notify_rules", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  target: text("target").notNull(),            // the sender/domain/keyword/thread spec to notify on
  kind: text("kind").notNull().default("sender"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ ix: index("notify_rules_account_idx").on(t.accountId) }));

export const awayResponders = sqliteTable("away_responders", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  subject: text("subject"),
  body: text("body"),
  startsAt: integer("starts_at", { mode: "timestamp_ms" }),
  endsAt: integer("ends_at", { mode: "timestamp_ms" }),
  /**
   * Who gets an automatic reply — `'screened_in'` (default) or `'everyone'` (mail 0051).
   * `screened_in` means only a sender the account has already let past the Screener: a message
   * still HELD gets no reply. That is the default because the Screener is a consent gate in both
   * directions — an away reply tells a stranger somebody is travelling and that the address is
   * live and read by a person. `everyone` is the explicit opposite choice. NOT NULL with a
   * default rather than nullable: this is not an on/off — an absent value would have to mean one
   * of the two members, and a reader guessing differently from the writer would widen an audience
   * nobody widened. The CHECK lives in the migration.
   */
  audience: text("audience").notNull().default("screened_in"),
  /**
   * How often one person may be answered — `'per_day'` by default (mail 0087). `always`: every
   * message. `per_message`: once, until the responder's TEXT changes — keyed by
   * `awayTextHash(body)`, not the row's `updated_at`: a save is not an edit, and keying on the
   * row made switching off and on re-answer everybody. `per_day` (default): one reply per person
   * per 24 h. `per_week`: one per 7 days. NOT NULL with a default: there is no "off" reading of
   * an absent value, and a reader guessing `always` where the writer meant `per_week` would
   * answer a correspondent seven times. The DEFAULT is the middle of the range: `always` is a
   * choice somebody makes, never one they inherit.
   */
  throttle: text("throttle").notNull().default("per_day"),
  /**
   * When the responder was last turned ON — the episode floor's first half. The floor used to be
   * `updated_at`, which every save moved: somebody who fixed a typo mid-trip pushed the floor
   * past mail that had already arrived, and every correspondent behind it was never answered at
   * all. `enabled_at` moves only on the OFF to ON transition (`nextEnabledAt`, one
   * implementation, used by `put` and the profile import), so an edit while away leaves the floor
   * where it was and the backlog inside the window stays answerable. Nullable: a never-enabled
   * responder has no such instant, and the pass reads NULL as "not live". Backfilled to
   * `updated_at` for rows already enabled when 0087 ran — the closest true statement available.
   */
  enabledAt: integer("enabled_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  /* Mail 0096/0101: a text[] on the server, a JSON array of strings here — the ruling for this
     landing. The closed set lives in the migration on both stores (the server CHECKs it with
     `<@`); nothing here reads a pile the phone writes, because the phone writes none today. */
  piles: text("piles", { mode: "json" }).notNull().default(sql`'["INBOX"]'`),
}, (t) => ({ uqAccount: unique().on(t.accountId) }));   // one row per account ⇒ PUT upserts

/**
 * ONE AUTOMATIC REPLY PER SENDER, AND THE ROW THAT PROVES IT — one row per
 * `(account, sender, enablement episode)`, and the UNIQUE is the guard rather than a diagnostic.
 *
 * ── WHAT AN "EPISODE" IS, AND WHY IT IS `responder_updated_at` ────────────────────────────────
 *
 * The requirement is at most one automatic reply per sender per enablement. A boolean "replied"
 * flag cannot express that: somebody comes back, turns the responder off, travels again next
 * month, and every correspondent from the first trip is permanently silenced. So the episode key is
 * the responder row's own `updated_at` — the instant of the PUT that produced the current
 * configuration. Turning the responder on again is a PUT, which moves `updated_at`, which starts a
 * new episode, which lets each sender be answered once more.
 *
 * The consequence to know about: ANY edit is a new episode, including a typo fix to the body while
 * away. Somebody who corrects their message mid-trip may answer a correspondent from earlier in
 * that trip a second time. That is the deliberate trade — the alternative keys (a separate
 * `enabled_at`, a nullable episode id) all reintroduce the permanent-silence failure the moment the
 * two columns disagree, and being answered twice is recoverable where never being answered is not.
 *
 * ── THE ROW IS WRITTEN BEFORE THE SEND, NEVER AFTER ─────────────────────────────────────────
 *
 * SMTP is not transactional, so the choice is at-most-once or at-least-once and there is no third
 * option. Claiming first makes a crash between the claim and the send cost ONE unsent reply;
 * claiming after would make it cost a duplicate reply to a stranger, forever, every time the pass
 * re-ran. `INSERT … ON CONFLICT DO NOTHING` returning zero rows IS the "somebody already answered
 * this sender" branch — there is no read-then-write window for two workers to race through.
 *
 * `sender` is the lowercased envelope author, never a display name. There is no FK to `messages`:
 * the record has to outlive the message it was triggered by (an expunge must not un-answer a
 * sender), and `message_id` is carried only as evidence, nullable, with no reference.
 */
export const awayResponderSent = sqliteTable("away_responder_sent", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  sender: text("sender").notNull(),
  responderUpdatedAt: integer("responder_updated_at", { mode: "timestamp_ms" }).notNull(),
  /** The message that triggered it, as evidence. Nullable, NO foreign key — see the header. */
  messageId: text("message_id"),
  /** The minted `<uuid@domain>` of the reply we sent, so a Sent-folder copy is attributable. */
  mintedMessageId: text("minted_message_id"),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  // THE GUARD. Not an index for speed — the ON CONFLICT target that makes "reply once" a
  // property of the schema instead of a property of the pass's control flow. Named explicitly
  // (rather than letting drizzle derive one) because the migration creates it by name.
  uqEpisode: uniqueIndex("away_responder_sent_episode_uq")
    .on(t.accountId, t.sender, t.responderUpdatedAt),
  ixAccount: index("away_responder_sent_account_idx").on(t.accountId),
}));

/**
 * The away reply ledger (mail 0087) — one row per DECIDED candidate, not only the sends: a
 * suppression nobody can attribute is indistinguishable from a pass that never ran — `outcome` +
 * `reason` is the durable answer; a held candidate that wrote nothing stayed a candidate forever,
 * pinning the oldest page of every cycle — a ledger row takes each decided row out of the
 * candidate set, so the window shrinks; and `UNIQUE (account_id, message_id)` is the structural
 * half of at-most-once — two runners race the INSERT, one gets a row. Written BEFORE the send:
 * `pending` commits with the throttle reservation, and the finalize is a compare-and-swap on
 * `outcome='pending'`. No FK on `message_id`: an expunge must not un-answer a correspondent.
 */
export const awayReplies = sqliteTable("away_replies", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  /** The mailbox the message ARRIVED in — the identity the reply is sent from. */
  mailboxId: text("mailbox_id").notNull(),
  /** The message that triggered it. NO foreign key — see the header. */
  messageId: text("message_id").notNull(),
  /** The lowercased envelope author. Never a display name. */
  sender: text("sender").notNull(),
  /**
   * What was decided; the CHECK (a closed five-member enum) lives in the migration. `pending` —
   * reserved, not yet sent; terminal only in the crash case, never retried. `sent` — SMTP
   * accepted it. `unverified` — SMTP threw: the delivery is AMBIGUOUS (it may have reached the
   * server), so the claim is KEPT and no second copy is ever offered; the interactive send path
   * answers the same ambiguity the same way. `throttled` — the per-sender reservation refused:
   * this person was answered recently enough. `suppressed` — an eligibility guard held; `reason`
   * names which.
   */
  outcome: text("outcome").notNull(),
  /** The suppression member, or the throttle setting that refused. Null for `sent`/`pending`. */
  reason: text("reason"),
  /**
   * The responder text this decision was made against — `awayTextHash(body)`. Stored on the
   * DECISION and not only on the sender state so that "why was this throttled" is answerable from
   * the ledger alone, without reconstructing what the responder said at the time.
   */
  textHash: text("text_hash"),
  /** The minted `<uuid@domain>` of the reply, so a Sent-folder copy is attributable. */
  mintedMessageId: text("minted_message_id"),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
}, (t) => ({
  // THE RESERVATION. Not an index for speed — the ON CONFLICT target that makes "one automatic
  // reply per message" structural. Named explicitly because the migration creates it by name.
  uqMessage: uniqueIndex("away_replies_message_uq").on(t.accountId, t.messageId),
  // The "why was this person not answered" read, and the throttle's own diagnostic.
  ixSender: index("away_replies_sender_idx").on(t.accountId, t.sender, t.decidedAt),
}));

/**
 * The per-sender throttle state (mail 0087) — one row per correspondent, and its `ON CONFLICT DO
 * UPDATE … WHERE` IS the throttle. A query over the ledger would be a READ: two runners can both
 * read "no" before either writes, and the correspondent gets two replies; serialising needs a row
 * to lock, and a row that does not exist cannot be locked. An upsert against a PRIMARY KEY has no
 * such gap: the two arms are one statement, the key serialises them, and the `WHERE` decides —
 * zero rows returned means the throttle refused, a decision, not a race. Not per-mailbox: the
 * throttle is a promise to a PERSON. Not shared across installs: a handover mid-window may cost
 * one duplicate per sender — filed rather than defended.
 */
export const awaySenderState = sqliteTable("away_sender_state", {
  accountId: text("account_id").notNull(),
  /** The lowercased envelope author. Half of the primary key, and the throttle's subject. */
  sender: text("sender").notNull(),
  /** When this person was last answered. NOT NULL: a row exists only because one was sent. */
  lastRepliedAt: integer("last_replied_at", { mode: "timestamp_ms" }).notNull(),
  /** The `awayTextHash` of what they were told — what `per_message` compares against. */
  lastTextHash: text("last_text_hash").notNull(),
  // Mail 0096: the instant a reply came back undeliverable.
  undeliverableAt: integer("undeliverable_at", { mode: "timestamp_ms" }),
}, (t) => ({
  // THE SERIALISER. The upsert's conflict target, so it is the primary key rather than a unique
  // index beside one: there is no other identity for this row.
  pk: primaryKey({ columns: [t.accountId, t.sender] }),
}));

/**
 * A decision made where the mailbox is READ, waiting for the install that ORGANIZES it (0.14.1).
 * The row is not the record: the IMAP mailbox is the only medium two installs share, so the thing
 * an organizer acts on is a message the reader appends to `ohmail/_meta` — this table is the
 * READER'S OWN BOOKKEEPING. Four states: `pending` (not yet appended), `sent` (in the mailbox),
 * `applied` (the organizer took it), `expired` (still there 24 h later — the sender returns to
 * the queue with a sentence saying so). Only the READER advances them, by LOOKING at the folder —
 * never by hearing from the organizer, which would need a channel neither side has. NO foreign
 * keys: the record must outlive the message and the mailbox row; erasure deletes by `account_id`.
 */
export const organizerRequests = sqliteTable("organizer_requests", {
  /** Also the `X-Ohmail-Request-Id` of the appended record — the two identities are one. */
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  /** The mailbox the decision is about. NO foreign key — see the header. */
  mailboxId: text("mailbox_id").notNull(),
  /**
   * WHICH APPLIER RUNS on the organizer side. Closed by `organizer_requests_kind_closed`, for the
   * reason every closed set in this file is closed: an unhandled member is resolved by whichever
   * branch the drain falls through to, and here that branch moves somebody's mail.
   */
  kind: text("kind").notNull(),
  /**
   * THE DECISION ITSELF, and it is UNTRUSTED INPUT on the organizer's side of the handover — it
   * arrives through an RFC822 header written by another install. It is validated by the same
   * function the organizer's own door validates with, before anything is applied, and bounded at
   * the write site.
   */
  payload: text("payload", { mode: "json" }).notNull(),
  /**
   * WHEN THE PERSON DECIDED, by the deciding door's clock. The drain applies in this order, so two
   * doors deciding one sender within one cycle land in the order the human made them rather than
   * in the order the IMAP server happens to list them.
   */
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }).notNull(),
  /** One of the FIVE states. Closed by `organizer_requests_state_closed`. */
  state: text("state").notNull().default("pending"),
  /** When it was appended to the mailbox. NULL while `pending`. */
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  /** When it became `applied`, `refused` or `expired`. NULL before that. */
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  /**
   * What the organizer said NO to, carried back on its ack record and shown to the person (mail
   * 0090). NULL in every state but `refused`. It exists because the four states could not tell a
   * person the one thing they need after pressing: a reader inferred `applied` from the record's
   * ABSENCE from the folder, and a record the organizer REFUSED and expunged is absent in exactly
   * the same way — the two mean opposite things, so absence stopped being evidence and an ack
   * carries the outcome. A CLOSED vocabulary this install defines, not free text and not a
   * stranger's: chosen by the drain from `RequestRefusal`, travelling through a header the same
   * drain writes — never a sentence a payload supplied.
   */
  refusedReason: text("refused_reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  // THE DRAIN'S OWN READ — "what of mine is still outstanding on this mailbox", once per cycle.
  // Without it that is a sequential scan of every request the install has ever made, per mailbox,
  // per cycle: no query is wrong and every test stays green, which is why the index census lists
  // it rather than trusting the shape.
  ixMailboxState: index("organizer_requests_mailbox_state_idx").on(t.mailboxId, t.state),
  // THE SCREENER LIST'S OWN READ (mail 0090). `listOutstandingForAccount` runs on every
  // `GET /screener` and asks by ACCOUNT, so the index above does not serve it — a different
  // leading column is a different index, and the miss is invisible to every test.
  ixAccountState: index("organizer_requests_account_state_idx").on(t.accountId, t.state),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0011 — attachment METADATA only. The BLOB bytes are NEVER
// stored server-side: this table holds filename/contentType/size
// + the IMAP `part_id` the on-demand fetch uses, and the bytes are streamed live
// from IMAP (`GET /attachments/:id`). Rows are written in the SAME transaction as
// their `messages` row at ingest (atomic — no orphan attachment without its
// message). `inline` marks a `related` (cid:) embedded image vs a real file.
// ─────────────────────────────────────────────────────────────────────────────
export const attachments = sqliteTable("attachments", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  messageId: text("message_id").notNull().references(() => messages.id),
  filename: text("filename"),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  partId: text("part_id"),                                  // IMAP MIME body-part number (on-demand fetch key)
  contentId: text("content_id"),                            // for inline (cid:) parts
  inline: integer("inline", { mode: "boolean" }).notNull().default(false),
  /**
   * `sha256(decoded bytes)`, hex — mail 0028. Computed in `mime.ts#toAttachmentMeta`, the one
   * moment the bytes are resident: the privacy rules forbid persisting them, and no later job can
   * recover them. The attachment half of {@link messageFingerprint}: without it, two messages
   * identical in every header and body but carrying DIFFERENT files of the same name, type and
   * size share one logical identity, and the second is filed as a duplicate and never shown.
   * NULLABLE and NOT backfilled: every row written before this migration has no digest and none
   * can be invented — the bytes are gone. That is exactly why the fingerprint is never computed
   * from stored columns.
   */
  contentSha256: text("content_sha256"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  ixMessage: index("attachments_account_message_idx").on(t.accountId, t.messageId),
}));

// Migration 0012 — Knowledge Base + manual drafts (the no-AI foundation; the AI drafter and gated
// send land later). `kb_entries` is the account's knowledge base: free-text title/content the
// drafter will retrieve over. A DB-managed `kb_tsv` generated column plus its GIN index back
// `KbService.retrieve` — the KB has its OWN lexical retrieval, not routed through SearchService.
// Core Postgres, no CREATE EXTENSION, so it replays into PGlite. REST-only: no
// `change_log`/`EntityType` growth; clients refetch. `drafts` is a STORED, never-auto-sent reply:
// `mailboxId` is NOT NULL (send must pick the identity/SMTP); `status`
// (draft|sending|sent|unverified) is the send-progress state a `draft` change row surfaces;
// `to`/`cc` are `EmailAddress[]` JSON.
export const kbEntries = sqliteTable("kb_entries", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  tags: text("tags", { mode: "json" }).notNull().default(sql`'[]'`),   // string[]
  // ── Migration 0015: the per-step crash-resume dedup key. When a
  // workflow `add_kb_entry` step writes this row it stamps `${runId}:${stepIndex}`
  // here; the UNIQUE (nullable ⇒ many NULLs allowed) + ON CONFLICT DO NOTHING means a
  // re-drain of the SAME run never inserts a second KB entry. NULL for user-authored
  // entries (the common case). ──
  workflowDedupKey: text("workflow_dedup_key"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  // DB-generated lexical index over title + content (regconfig LITERAL pinned so the
  // generation expression is IMMUTABLE, like 0008). The app NEVER writes it.
}, (t) => ({
  ixAccount: index("kb_entries_account_idx").on(t.accountId),
  uqWfDedup: unique("kb_entries_workflow_dedup_key_unique").on(t.workflowDedupKey),   // per-step idempotency
}));

export const drafts = sqliteTable("drafts", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id),   // the mailbox this draft sends from
  threadId: text("thread_id").references(() => threads.id),                  // reply target thread (nullable)
  inReplyToMessageId: text("in_reply_to_message_id").references(() => messages.id),  // nullable
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  // ── Migration 0037: the RICH half. NULL means "this draft is plain text", which is the
  // truth for every draft written before rich compose and for every one a client that does not
  // send html writes afterwards. `body` is never derived away — when `html` is present it holds
  // the text/plain alternative derived from it, so the two parts of the multipart cannot drift
  // and a code path that predates this column still sends the right words. Sanitized by
  // `sanitizeOutboundHtml` before it is written; capped at 256 KiB by `drafts_html_cap`. ──
  html: text("html"),
  to: text("to", { mode: "json" }).notNull().default(sql`'[]'`),   // EmailAddress[]
  cc: text("cc", { mode: "json" }).notNull().default(sql`'[]'`),   // EmailAddress[]
  // Migration 0045. Bcc rides the SMTP ENVELOPE ONLY — `SendService.reserve` copies it into
  // `OutboundMessage.bcc` and nodemailer never writes a Bcc header into the message or the Sent
  // copy. Stored here (not just on the create request) because the send is a second, recipient-less
  // request that reads this row to build the envelope. ──
  bcc: text("bcc", { mode: "json" }).notNull().default(sql`'[]'`),   // EmailAddress[]
  rationale: text("rationale"),                          // AI drafter's reasoning (3b); null for manual compose
  status: text("status").notNull().default("draft"),     // draft|scheduled|sending|sent|unverified
  // ── Migration 0015: the per-step crash-resume dedup key — see
  // `kb_entries.workflow_dedup_key`. A workflow `draft_reply` step stamps
  // `${runId}:${stepIndex}`; UNIQUE + ON CONFLICT DO NOTHING means a re-drain never
  // stores a second draft. NULL for manual/AI-route drafts. ──
  workflowDedupKey: text("workflow_dedup_key"),
  // Mail 0077 — send later: the draft carries WHEN it should leave. `send_at` + `status =
  // 'scheduled'` are written together by `ScheduleService.schedule`; the worker's scheduled-send
  // pass claims due rows and runs the ordinary gated send. `send_key` is the send's
  // Idempotency-Key, minted AT SCHEDULE TIME so a crashed claim retries with the same key and
  // replays instead of re-delivering; both survive the claim and are cleared on a terminal
  // outcome or a cancel. `send_error` is the failure sentence from an appointment that could not
  // be kept, cleared by the next edit. The appointment lives HERE and never on `outbound_sends`,
  // whose `pending` rows mean "an invocation is live right now, OR one died holding this" — the
  // reconciling pass tells the two apart, and the stuck-send alarm reads the residue: a row still
  // `pending` past its threshold is one the reconciler has not drained.
  sendAt: integer("send_at", { mode: "timestamp_ms" }),
  sendKey: text("send_key"),
  sendError: text("send_error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  ixAccount: index("drafts_account_updated_idx").on(t.accountId, t.updatedAt),
  uqWfDedup: unique("drafts_workflow_dedup_key_unique").on(t.workflowDedupKey),   // per-step idempotency
  // Mail 0077 — the worker's due scan (`status = 'scheduled' AND send_at <= now()`), partial so
  // it holds only live appointments and ordinary draft churn never touches it.
  ixScheduledDue: index("drafts_scheduled_due_idx").on(t.sendAt)
    .where(sql`${t.status} = 'scheduled'`),
}));

// Migration 0013 — the gated idempotent send state machine. ONE row per (accountId,
// idempotencyKey): the UNIQUE is the reservation gate SendService inserts through with `ON
// CONFLICT DO NOTHING` BEFORE any SMTP call (no network in a transaction). `minted_message_id`
// (`<uuid@domain>`) is minted UP FRONT and passed to SMTP as the Message-ID, so a crashed attempt
// is later VERIFIED by searching the Sent folder for exactly that id rather than blindly resent.
// `pending → sent` is a delivered send; `unverified` is the terminal AMBIGUOUS outcome (SMTP
// result unknown, id not in Sent), surfaced to the user and NEVER auto-resent; `failed` is
// definitively undelivered. A domain state machine the generic `idempotency_keys` cache cannot
// model (no `pending` state), so `/drafts/:id/send` is not idempotent-marked — SendService owns
// this reservation itself.
export const outboundSends = sqliteTable("outbound_sends", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  /* Mail 0095: nullable, and the reference clears rather than blocks — a send outlives the draft
     it came from, and the server made the same change in the same migration. */
  draftId: text("draft_id").references(() => drafts.id, { onDelete: "set null" }),
  mintedMessageId: text("minted_message_id").notNull(),      // `<uuid@domain>` minted up front
  providerMessageId: text("provider_message_id"),            // the delivered Message-ID (null until sent)
  status: text("status").notNull().default("pending"),       // pending|sent|failed|unverified
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  // Mail 0095: who resolved this send, and when.
  resolvedBy: text("resolved_by"),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
}, (t) => ({
  uqKey: unique().on(t.accountId, t.idempotencyKey),         // the per-account idempotency reservation gate
}));

// Migration 0014 — workflow automation storage. Two additive, account-scoped, REST-only tables:
// neither writes `change_log` nor grows `EntityType` — clients refetch; the workflow EFFECTS (a
// `file_message` move, a `draft_reply` draft) still sync as their own changes. `workflows` is a
// user-authored automation: `trigger`/`steps` are jsonb (the only tools a step may declare are
// file_message/draft_reply/add_kb_entry — send/forward are rejected at the service boundary);
// `enabled` defaults FALSE (enabling IS the consent to auto-apply); `deletedAt` is a soft delete
// so `workflow_runs` history survives. `workflow_runs` is one row per enqueued run: a retried
// Idempotency-Key replays the same runId (row + verbatim response commit in one transaction);
// `workflowId` is nullable; `stepCursor` is the durable per-run resume cursor.
export const workflows = sqliteTable("workflows", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  trigger: text("trigger", { mode: "json" }).notNull().default(sql`'{}'`),   // WorkflowTrigger {kind:'manual'|'time'|'event', nextRunAt?, match?}
  steps: text("steps", { mode: "json" }).notNull().default(sql`'[]'`),       // WorkflowStep[]
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),            // enabling IS the consent
  provenance: text("provenance").notNull().default("user"),        // proposed|user|graduated
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),      // soft-delete marker
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ ixAccount: index("workflows_account_idx").on(t.accountId) }));

export const workflowRuns = sqliteTable("workflow_runs", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  workflowId: text("workflow_id").references(() => workflows.id),   // NULLABLE — retain runs past a soft-delete
  status: text("status").notNull().default("pending"),             // pending|running|awaiting_approval|succeeded|failed|undone
  trigger: text("trigger", { mode: "json" }).notNull().default(sql`'{}'`),   // snapshot of the workflow trigger at enqueue
  log: text("log", { mode: "json" }).notNull().default(sql`'[]'`),           // per-step convenience index (canonical inverse = audit_log)
  stepCursor: integer("step_cursor").notNull().default(0),         // durable resume cursor
  reason: text("reason"),                                          // failure/skip reason (nullable)
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  // Mail 0033 — when the `running` claim was made. Written once, by the drain's guarded `pending
  // → running` UPDATE, read only by the reaper that requeues a run whose worker died holding it.
  // Neither existing column answers "how long unattended": `createdAt` dates the ENQUEUE,
  // `finishedAt` is what a stranded row lacks. NULLABLE with no default: a default would stamp
  // every `pending` row with a claim no worker made; NULL means "claimed by code predating this
  // column", resolved through `createdAt`. WRITE IT ONLY FROM A JS `Date` — never `defaultNow()`
  // or `sql`now()``: the reaper's guarded requeue re-asserts the stamp it observed, round-tripped
  // through a millisecond `Date`, and a value carrying microseconds can never be matched again —
  // selected as stale on every pass, requeued on none, silently. Migration 0033 names the
  // measurement.
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
}, (t) => ({ ixAccountStatus: index("workflow_runs_account_status_idx").on(t.accountId, t.status) }));

// Migration 0016 — AI workflow PROPOSALS. The proposer reads NON-SENSITIVE pattern metadata only
// (sender/domain/destination/count/provenance from learning signals, routing decisions and rules
// — never bodies or snippets) and stores suggested automations here. A proposal is INERT: never a
// workflow until the user explicitly materializes it (`POST /workflows { fromProposalId }`),
// which creates a `provenance='proposed', enabled=false` row — never auto-enabled. REST-only: no
// `change_log`/`EntityType` growth; clients refetch. `sourcePattern` records the redacted
// metadata the suggestion was derived from (audit/UI only). `status` open|materialized|dismissed.
export const workflowProposals = sqliteTable("workflow_proposals", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  rationale: text("rationale").notNull().default(""),
  trigger: text("trigger", { mode: "json" }).notNull().default(sql`'{}'`),   // WorkflowTrigger
  steps: text("steps", { mode: "json" }).notNull().default(sql`'[]'`),       // WorkflowStep[] (allowlisted tools only)
  sourcePattern: text("source_pattern", { mode: "json" }),                          // redacted WorkflowPattern metadata (nullable)
  status: text("status").notNull().default("open"),                // open|materialized|dismissed
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({ ixAccountStatus: index("workflow_proposals_account_status_idx").on(t.accountId, t.status) }));

// Migration 0031 — TAGS. Ours, never IMAP. A tag is a row in OUR store, keyed by message — never
// an IMAP folder: ohmail organizes the mailbox in place with exactly the fixed `ohmail/*` set
// plus INBOX, and a tag is a cross-cutting dimension OVER those places, not a seventh place; tags
// as folders would also mean a per-message IMAP COPY, which leave-anytime refuses. The honest
// consequence, stated in the UI: a tag lives only here, so it survives a disconnect (a soft
// delete, reversible) but not account erasure, and it does not outlive its message. NO
// `class_name` column: a CSS class is not account data and a server has no business minting one —
// `hue` is the stored dimension and the client maps it.
export const tags = sqliteTable("tags", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  name: text("name").notNull(),
  hue: text("hue").notNull().default("moss"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  // ONE TAG PER NAME PER ACCOUNT, case-insensitively. On `lower(name)` and not on
  // `name`, because nothing lowercases this column on write — it is the label the
  // user typed and it is shown back to them verbatim — so "Invoices" and "invoices"
  // must collide without either being mangled at rest. The contacts/mailboxes
  // precedent (`mailboxes_active_address_uq`). There is NO partial predicate here:
  // tags have no soft-delete state, a delete is a real delete, so there is no
  // tombstone for a re-created name to collide with. Declared here to keep the TS
  // schema honest — the index is created by the migration and a test diffs this declaration
  // against the real catalog.
  uqAccountName: uniqueIndex("tags_account_name_uq").on(t.accountId, sql`lower(${t.name})`),
}));

/**
 * The assignment. PK `(message_id, tag_id)` — the natural key, and what makes a double-assign a
 * no-op instead of a duplicate row: `INSERT … ON CONFLICT DO NOTHING` on this PK carries two
 * concurrent toggles of the same tag on the same message, with no read-modify-write and no lost
 * update. `account_id` is DENORMALIZED deliberately: every read is account-scoped and the
 * materialize path fetches labels for a page of messages at once, so the lookup is one index scan
 * on `(account_id, message_id)` instead of a join back through `messages` on every page of every
 * sync drain.
 */
export const messageTags = sqliteTable("message_tags", {
  accountId: text("account_id").notNull(),
  messageId: text("message_id").notNull().references(() => messages.id),
  tagId: text("tag_id").notNull().references(() => tags.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.messageId, t.tagId] }),
  // The materialize lookup: "every label on these messages, for this account".
  ixAccountMessage: index("message_tags_account_message_idx").on(t.accountId, t.messageId),
  // The delete sweep: `DELETE /tags/:id` clears assignments before the parent.
  ixTag: index("message_tags_tag_idx").on(t.tagId),
}));

/**
 * Auto-unsubscribe leaves a list ONCE — one row per (mailbox, list) the account has asked to
 * leave. `uqMailboxList` IS the concurrency design: the claim is `INSERT … ON CONFLICT DO NOTHING
 * RETURNING id`; two workers racing the same list both attempt it, one gets a row, the loser
 * sends nothing — the unique index IS the mutual exclusion. `listKey` is the RFC 2919 `List-ID`
 * when published, else `lower(from_address)` — NOT the unsubscribe URL (its per-message token
 * would send once per message, the exact defect this prevents) and not `from_address` alone
 * (senders vary the address per send; the user experiences one list). Scoped to the MAILBOX: two
 * mailboxes subscribed to one newsletter are two subscriptions with two tokens.
 */
export const unsubscribeRecords = sqliteTable("unsubscribe_records", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  mailboxId: text("mailbox_id").notNull().references(() => mailboxes.id),
  listKey: text("list_key").notNull(),
  /** 'claimed' | 'sent' | 'refused' | 'failed' — closed by a CHECK in the migration. */
  state: text("state").notNull(),
  /** Which refusal, when `state='refused'`. Null otherwise. */
  refusal: text("refusal"),
  /** The sender's HTTP status when `state='sent'`, including a non-2xx. Null otherwise. */
  httpStatus: integer("http_status"),
  /** The message that supplied the URL — evidence for why this list was left. */
  messageId: text("message_id").notNull().references(() => messages.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  uqMailboxList: uniqueIndex("unsubscribe_records_mailbox_list_uq").on(t.mailboxId, t.listKey),
  ixAccount: index("unsubscribe_records_account_idx").on(t.accountId),
}));

/**
 * One row per account that has CHANGED something — and no row for anyone who has not. Absence is
 * a legal state meaning "all defaults": every reader treats a missing row that way, nothing is
 * backfilled, and the row is created lazily on first write (mail 0035). Deliberately GENERAL:
 * preferences arrive one feature at a time, and a new per-account setting is a column here.
 * `dormancyDays` NULL means "use the product default" rather than storing it, so changing the
 * default moves every account that never touched the dial. `seedConfirmedAt` is NOT derivable
 * from "does a seeded rule exist": unchecking every row and confirming is a real answer, and the
 * derived form reads it as "never asked", so onboarding would offer the seed forever.
 */
export const accountSettings = sqliteTable("account_settings", {
  accountId: text("account_id").primaryKey(),
  /** Cutline dial, in days. NULL = the product default. CHECK (> 0) lives in the migration. */
  dormancyDays: integer("dormancy_days"),
  /** When the sent-mail seed review was confirmed. THE consent event of onboarding. */
  seedConfirmedAt: integer("seed_confirmed_at", { mode: "timestamp_ms" }),
  /** Senders that confirm covered, and how many were unchecked first. Reported, never read. */
  seedConfirmedCount: integer("seed_confirmed_count").notNull().default(0),
  seedDeclinedCount: integer("seed_declined_count").notNull().default(0),
  /** When screening state was last wiped. A supported operation, so it is account state. */
  screeningResetAt: integer("screening_reset_at", { mode: "timestamp_ms" }),
  /**
   * AUTO-SUGGEST FOR NEW SENDERS — when the account opted in, or NULL for off (mail 0040).
   *
   * ON means: while the Screener is open, ohmail buys a classifier suggestion for the senders at
   * the front of the queue so each stranger arrives with a verdict and a reason. It does NOT
   * decide — no rule, no contact, no `folder_state`, no move, and `ScreenerService.store` emits
   * no `change_log` row, so a suggestion never reaches the delta feed. A stranger still waits for
   * a human.
   *
   * The opt-in exists because a suggestion is a METERED action: this flag authorises spending the
   * account's credits without a per-batch click, and nothing else. **NULL and "no row at all"
   * must both read as OFF, and so must a settings read that failed** — defaulting the other way
   * would spend money on a fetch error.
   *
   * A timestamp for the same reason as `seedConfirmedAt`: "was this on before or after the
   * screening reset?" is a real question and a boolean cannot answer it. Read as `IS NOT NULL`
   * and never as a deadline, so a skewed clock cannot make it mean anything else.
   */
  autoSuggestAt: integer("auto_suggest_at", { mode: "timestamp_ms" }),
  /**
   * WHO REACHES THE OHBOX — the account's posture (mail 0042). NULL / `'people_and_replied'` =
   * today's lenient behaviour; `'people_only'` = demote automated mail from inferred-admission
   * senders out of the Ohbox. The CHECK (enum, closed) lives in the migration. **NULL reads
   * LENIENT** at every layer — the engine resolves absent config to `DEFAULT_OHBOX_POLICY`, so
   * shipping the column demotes nobody until they opt in. See `packages/core/src/rules.ts`.
   */
  ohboxPolicy: text("ohbox_policy"),
  /**
   * The plain-language Ohbox bar in the account owner's own words (mail 0042). NULL = show the product
   * default; readers fall back to the default constant. It is threaded into the classifier's USER
   * turn, never routing itself. Length-capped at 2 KiB by the migration's CHECK.
   */
  ohboxBar: text("ohbox_bar"),
  /**
   * THE OHBOX BACKLOG TIDY — the resumable, re-armable marker for the one worker pass that
   * re-routes mail ALREADY misfiled into the Ohbox under `people_only` (mail 0043). New mail is
   * demoted live by the engine; these three columns are the durable state for the retroactive
   * clean-up of what was placed before the account opted in. The shape is `rules.retro_*` lifted
   * from a per-RULE marker to a per-ACCOUNT one, because the pass pages `folder_state` by
   * `account_id` and one cursor covers all of an account's mailboxes.
   *
   *   ohbox_tidy_requested_at  the account asked for the backlog to be re-routed. Stamped by
   *                            `setScreeningPreference` ONLY on the transition INTO `people_only`
   *                            (and by the future "tidy now" button), and the cursor is NULLed in
   *                            the same UPDATE — re-arming without resetting the cursor would resume
   *                            at the end and move nothing.
   *   ohbox_tidy_done_at       the pass drained the backlog. Owed = `people_only` AND
   *                            `requested_at IS NOT NULL` AND (`done_at IS NULL` OR
   *                            `done_at < requested_at`). Written LAST (0030's rule): claiming it
   *                            first makes a crash permanent. Re-armable — a later `requested_at`
   *                            past `done_at` re-owes the work, which is what the button needs.
   *   ohbox_tidy_cursor        resume point: the last `messages.id` of the last COMMITTED page. The
   *                            live pass reads it to resume across worker cycles; a dry-run plan
   *                            reads it as a start and advances only in memory (it commits nothing).
   *
   * NULL on every existing account, and that is correct: no account has asked for a tidy, so none
   * is owed. An account already `people_only` before this migration has no `requested_at` and is
   * never owed until it re-saves the posture or presses the button — deliberate, so shipping the
   * columns moves no mail.
   */
  ohboxTidyRequestedAt: integer("ohbox_tidy_requested_at", { mode: "timestamp_ms" }),
  ohboxTidyDoneAt: integer("ohbox_tidy_done_at", { mode: "timestamp_ms" }),
  ohboxTidyCursor: text("ohbox_tidy_cursor"),
  /**
   * SCREENER AUTO-APPLY — when the account opted in, or NULL for off (mail 0046). ON means: the
   * worker's auto-apply pass files obvious strong-bulk senders (the deterministic
   * `migrationBulkPlacement` floor — `List-Unsubscribe` plus a corroborating list/ESP marker) OUT
   * of the Screener into Reads/Receipts, so the queue is not clogged by newsletters and receipts a
   * human would only wave through.
   *
   * It applies DETERMINISTIC routing only: no classifier call, no credit debit, no auto-purchase of
   * paid AI suggestions. Every move is durable and user-reversible (a `folder_state` placement plus
   * a `change_log` move plus an `audit_log` inverse), never a delete, and it writes NO `rules` row —
   * the sender still screens next time. A sensitivity-flagged message (`sensitivity_category` set OR
   * `no_ai`) is NEVER auto-moved — the same cross-class KEEP the live router and the Ohbox backfill
   * apply — so a stranger's login code stays at the gate for a human.
   *
   * A timestamp, not a boolean, for the same reason as {@link autoSuggestAt}: "was this on before or
   * after the screening reset?" is a real question. **NULL, no row, and a FAILED read must all read
   * as OFF** — defaulting the other way would move mail on a fetch error. Read as `IS NOT NULL`,
   * never as a deadline.
   */
  screenerAutoApplyAt: integer("screener_auto_apply_at", { mode: "timestamp_ms" }),
  /**
   * "USE FOLDERS" — when the account turned the optional folders feature on, or NULL for off
   * (FOLDERS-SPEC.md §6; owner decision 1, 2026-08-22: fully optional, disabled by default).
   *
   * ON means: the mailbox's OWN folders — the passive-presence inventory in `mailbox_folders`,
   * minus the organized six, the Sent folder and the `ohmail` namespace — are materialized as
   * `folder` entities on /sync, so the client renders them in the rail with counts and opens
   * them as views. It moves NO mail and issues NO IMAP command: first render on a
   * fifteen-year-old mailbox is a read-only act (spec §10). The WRITE transition appends the
   * matching `change_log` rows (creates on enable, delete tombstones on disable) so a live
   * mirror follows without a re-bootstrap — see `setFoldersEnabled`.
   *
   * A timestamp for {@link autoSuggestAt}'s reason ("was this on before or after X" is a real
   * question), read as `IS NOT NULL`, never as a deadline. **NULL, no row, and a failed read
   * all mean OFF** — off is the pre-feature interface byte for byte, so there is no path from
   * "I do not know" to a surface the account never asked for.
   */
  foldersEnabledAt: integer("folders_enabled_at", { mode: "timestamp_ms" }),
  /**
   * WHEN THIS ACCOUNT FINISHED SCREENING ITS BACKLOG  — the instant the dormancy
   * window is measured back from, instead of from `now()`.
   *
   * The cutline reads `(screeningBaselineAt ?? now()) - dormancyDays`. With a baseline the cutoff
   * STOPS SLIDING, which buys two properties the sliding window could not express:
   *
   *   · mail older than the cutoff can never make an undecided sender active — **not even
   *     unread**. That is the churn this column exists for: old unread mail arrives in the mirror
   *     constantly (a backfill reaching further back, a folder read for the first time, a `\Seen`
   *     flag adopted late), and under the sliding window every such arrival resurrected a sender
   *     the account had already worked past, then dropped them again when the read-state synced;
   *   · a stranger who wrote AFTER the baseline never goes dormant — their mail is newer than the
   *     cutoff for ever — so they wait until somebody decides instead of ageing quietly out of
   *     the queue unanswered.
   *
   * **NULL is exactly the pre-0056 behaviour at every layer**, and this is the one property to
   * preserve when editing any reader: cutoff = `now() - dormancyDays`, unread outranks age, and
   * the router holds any unruled sender's mail at the gate whatever its date. The narrowing is
   * gated on the baseline being PRESENT, never applied unconditionally through a `?? now()`
   * default — those are different programs, and the second one empties a live account's Screener
   * queue on deploy.
   *
   * Unlike every other timestamp on this row it is read as an INSTANT and not as `IS NOT NULL`:
   * the value is what the arithmetic uses. Written once, by the account's first screener decide,
   * in that decide's own transaction and only while still NULL — so two decides racing produce
   * one baseline. Never recomputed, and deliberately NOT derived from `min(rules.created_at)`,
   * because rules are deletable and a baseline that can travel backwards would re-open the queue
   * every time somebody tidies their rules.
   */
  screeningBaselineAt: integer("screening_baseline_at", { mode: "timestamp_ms" }),
  /**
   * REMOTE IMAGES — the OPT-OUT, and the direction is the whole design (mail 0048).
   *
   * NULL (and no row) = the product default: a message's remote images load automatically,
   * through `GET /img`, which fetches server-side so the sender never learns the reader's
   * address. NOT NULL = this account asked to keep the per-message "Show images" consent flow,
   * and the instant is when they asked.
   *
   * Stored as the opt-out rather than as an opt-in so the default moves with the product: an
   * opt-in column would leave every existing account, and everyone who never finds the setting,
   * on the old behaviour — which is a default nobody is on. Same argument as `dormancyDays`'
   * "never store the default", one column over.
   *
   * **This is the ONE flag on this row whose failed read must default to the NON-null branch.**
   * `autoSuggestAt` and `screenerAutoApplyAt` read a failed fetch as OFF because ON spends money
   * or moves mail. Here, "off" is what loads remote content, so an unknown answer resolves to
   * MANUAL (`consent-state.ts`'s resting value) — a client that could not ask must never load
   * trackers for somebody who opted out. Row-absent is NOT that case: it is a real answer from a
   * server that read the row, and it means auto.
   *
   * A TRACKING PIXEL IS UNAFFECTED IN EITHER MODE. The sanitizer classifies beacons and 1×1s
   * separately and overrides the proxy for them; this flag governs pictures only.
   */
  blockRemoteImagesAt: integer("block_remote_images_at", { mode: "timestamp_ms" }),
  /**
   * TRACKING PIXELS — the OPT-OUT of a protection, and the sign is the opposite of the column
   * above (mail 0072).
   *
   * NULL (and no row) = the product default: a beacon, a 1×1 or a zero-dimension image is never
   * fetched, in either images mode. NOT NULL = this account asked for tracking pixels to load
   * along with the pictures, and the instant is when they asked.
   *
   * Two opt-out columns side by side whose NULLs mean OPPOSITE postures: {@link blockRemoteImagesAt}
   * NULL is permissive (pictures load), this NULL is protective (pixels blocked). Both store the
   * reader's departure from the default and never the default itself; what differs is which way
   * the default points, and a reader of the row must not assume the two NULLs agree.
   *
   * The client's failed-read direction is therefore the SAME as its row-absent direction, unlike
   * its neighbour: unknown ⇒ blocked, because loading a beacon for somebody who never asked is the
   * one outcome this column may not produce. It governs only the sanitizer's pixel override, and
   * only where a proxy exists — a pixel loads through `GET /img` like any picture or not at all.
   */
  loadTrackingPixelsAt: integer("load_tracking_pixels_at", { mode: "timestamp_ms" }),
  /**
   * AUTO-UNSUBSCRIBE ON SCREEN-OUT — the OPT-OUT, and the second column on this row spelled that
   * way (mail 0054).
   *
   * NULL (and no row) = the product default: screening a waiting sender out, or the Screener's
   * spam verb, hands the mail that decision re-routed to the RFC 8058 one-click path — one request
   * per list per mailbox, only where the sender published `List-Unsubscribe-Post`, never
   * `mailto:`, sent server-side. NOT NULL = this account asked it to stop, and the instant is when.
   *
   * The opt-out spelling is not a style choice here the way it is arguable for
   * {@link blockRemoteImagesAt}: the behaviour is ALREADY ON for every account that exists, so an
   * opt-in column would have turned it off for all of them on deploy.
   *
   * **The reader is `UnsubscribeService.onScreenOut` — the AUTOMATIC entry point — and nothing
   * else.** The manual button on one open message is a person pressing unsubscribe on mail in
   * front of them, and gating that on a switch named "auto" would make a control mean something
   * its label does not say.
   *
   * A failed CLIENT read resolves to ON, which is the opposite direction from
   * {@link blockRemoteImagesAt} and is deliberate: what the client does with this value is decide
   * whether to DISCLOSE an irreversible outbound request the server is going to make anyway, so
   * "I do not know" must not silently drop the disclosure. The server has no unknown — it reads
   * this column in the same request that would send.
   */
  blockAutoUnsubscribeAt: integer("block_auto_unsubscribe_at", { mode: "timestamp_ms" }),
  /**
   * THE INTERFACE LANGUAGE — `'en' | 'de'`, or NULL for "nobody has chosen" (mail 0053). The CHECK
   * (enum, closed) lives in the migration.
   *
   * The only column on this row that is neither a timestamp nor a switch, and the only one whose
   * value a CLIENT resolves rather than a service. What reads it: `GET /consent` sends it, and the
   * client adopts it at boot — which is the whole feature, because "my account is in German" has to
   * hold on a machine that has never seen this account.
   *
   * **NULL is not `'en'`, and collapsing the two would break the one guard that matters.** A device
   * remembers its own language in `localStorage` (the standalone install has nothing else, and the
   * sign-in screen has no account yet). The rule is: an account preference WINS over the device's,
   * and an account with no preference LEAVES THE DEVICE ALONE. Storing `'en'` for everyone who never
   * opened the selector would make every boot on a German-set browser silently reset to English —
   * so the default is never stored, exactly as `dormancyDays` is not, and `setLocale` maps a request
   * for the default back to NULL.
   *
   * A FAILED read is not "English": `consent-state.ts` leaves the field null, which means "keep the
   * device's language". That is the safe direction here in the same way MANUAL is for
   * `blockRemoteImagesAt` — the cost of guessing wrong is an interface somebody cannot read, and the
   * device's own remembered choice is a better guess than the product default.
   */
  locale: text("locale"),
  /**
   * THE APPEARANCE FACE — `'paper' | 'ohmarchy'`, or NULL for "nobody has chosen" (mail 0082).
   * The CHECK (enum, closed) lives in the migration. The paper/ohmarchy axis of appearance;
   * light/dark stays device-local and never reaches this table.
   *
   * Reads and writes exactly as {@link locale} does — `GET /consent` sends it, the client adopts
   * it, `PATCH /consent/settings` writes it — with ONE deliberate inversion: **the default IS
   * stored.** `setThemeFace('paper')` persists `'paper'`, because NULL and "asked for paper" are
   * different states on a LINUX device, which defaults to ohmarchy when nobody has chosen
   * anywhere (Option B, OHMARCHY-PLAN.md §3a). An explicit account-wide 'paper' is what
   * overrides that detection; collapsing it to NULL would make the request unsayable on the one
   * class of device it targets. The migration's header carries the full argument.
   *
   * Scope note: this column is the "apply for all devices" half. "Only this device" never
   * reaches the server — it is the device's `localStorage` pin, which outranks this column on
   * that device (that is what the scope option promised when it was chosen).
   */
  themeFace: text("theme_face"),
  /**
   * WHEN THIS ACCOUNT FINISHED (OR CANCELLED) THE FIRST-RUN FLOW — the mailbox-removal design.
   *
   * Onboarding state is DERIVED from truth-conditions and never from a step counter: the current
   * step is the first UNMET of consent → screening baseline → import complete → AI answered →
   * this. Every other condition already has a witness somewhere in the schema; this is the one
   * that has none, because "the person is done with the flow" is not a fact about their mail.
   *
   * **CANCEL AND FINISH BOTH STAMP IT**, and that is the point rather than a shortcut: cancel
   * means "stop asking me", and a cancel that left the column NULL would re-open the flow on the
   * next launch for ever. Re-running from Settings re-renders pre-filled from truth and
   * re-stamps, so the value is the LAST completion and not the first.
   *
   * Read as `IS NOT NULL`, like every other stamp on this row bar {@link screeningBaselineAt}.
   */
  onboardingCompletedAt: integer("onboarding_completed_at", { mode: "timestamp_ms" }),
  /**
   * SCREENING SCOPE — `'window'` (the default) or `'all_time'`. Mail 0083, CHECK in the migration.
   *
   * **"All time" is a MODE, not a window value, and there was no way to spell it before.**
   * `dormancyDays` is bounded 1–365 at the write site and NULL means the product default, so no
   * number in that column says "no cutoff at all" — the onboarding step offers 90 · 180 · 365 ·
   * all time, and the fourth option needed somewhere to live.
   *
   * `'all_time'` ⇒ NO cutoff and NO dormancy, in BOTH readers: `resolveScreeningCutoff` on the
   * server and `consent-cutline.ts` on the client, held in step by a parity test. Everything is
   * screened, nothing is filed to History unscreened, and no sender ever ages out of the queue
   * unanswered.
   *
   * NOT NULL with the default stored, unlike {@link dormancyDays} beside it, and the difference
   * is that this column has no device-local default to defer to: 'window' is what every existing
   * account is on and what the absent value means, so storing it costs nothing and removes a
   * three-valued read from two cutline implementations.
   */
  screeningScope: text("screening_scope").notNull().default("window"),
  /*
   * NO REQUEST-KEY COLUMN HERE, AND THE ABSENCE IS THE DESIGN (mail 0090).
   *
   * A reader's decision record is signed so an organizer can tell this account's own install from
   * anything else with write access to `ohmail/_meta`. The first cut of that stored a per-account
   * key on this row and handed it to each install over the hosted API. It is withdrawn: a LOCAL
   * install talks only to the mail server and has no authenticated call to fetch one on, and
   * giving it such a call would mean giving the sealed local artifact a session it deliberately
   * does not have.
   *
   * The key is HKDF-SHA256 over the MAILBOX PASSWORD instead — the one secret both installs
   * already hold, and one the attacker in question (folder rights via an ACL or a sieve rule) does
   * not — computed at use and never stored. See `deriveRequestKey`
   * (`@trafficflow/core/adapters/organizer-lease`). Nothing to store here, nothing to leak from
   * this table, and no rotation column: changing the password changes the key, which is exactly
   * when older records should stop verifying.
   */
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
});

/**
 * Mail 0094: the organizer profile as last read from the mailbox, cached per mailbox.
 *
 * `uidvalidity` is a 64-bit counter for the reason every other one here is — it is compared, and a
 * double loses the low bits. `doc` is the profile document, JSON text read through the JSON
 * functions, exactly as its twin stores jsonb.
 */
export const mailboxProfileMirror = sqliteTable("mailbox_profile_mirror", {
  mailboxId: text("mailbox_id").primaryKey(),
  accountId: text("account_id").notNull(),
  uidvalidity: int64("uidvalidity"),
  uid: integer("uid"),
  doc: text("doc", { mode: "json" }).notNull(),
  readAt: integer("read_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  ixAccount: index("mailbox_profile_mirror_account_idx").on(t.accountId),
}));

/**
 * Mail 0093: one row per reserved send content, so a retry cannot send twice.
 *
 * THE HEX CHECK IS SPELLED DIFFERENTLY AND MEANS THE SAME THING. The server writes a POSIX regex
 * (`~ '^[0-9a-f]{64}$'`); this store has no regex operator, and the only door to one is a
 * host-registered `REGEXP` function — a CHECK that depends on one makes the file unopenable by a
 * host that lacks it, which is the failure this schema refuses elsewhere by capability. The pair
 * is recorded in `schema-twin-parity.test.ts` so neither half can drift alone.
 */
export const outboundSendFingerprints = sqliteTable("outbound_send_fingerprints", {
  id: text("id").default(UUID_V4).primaryKey(),
  accountId: text("account_id").notNull(),
  mailboxId: text("mailbox_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  sendId: text("send_id").notNull().references(() => outboundSends.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).default(NOW_MS).notNull(),
}, (t) => ({
  uqContent: unique("outbound_send_fingerprints_content_uq").on(t.accountId, t.mailboxId, t.fingerprint),
  ckFingerprint: check(
    "outbound_send_fingerprints_hex",
    sql`length(${t.fingerprint}) = 64 and ${t.fingerprint} not glob '*[^0-9a-f]*'`,
  ),
}));

/**
 * The mail-domain half as one object, for `drizzle(client, { schema })`.
 *
 * Spread into `schema` by `./schema.js` for every consumer that wants both halves. A local
 * install passes THIS one and nothing else — see `apps/sidecar/src/db.ts`.
 */
export const mailSchema = {
  mailboxes, mailboxCredentials, mailboxFolders, messages, messageInstances, messageFailures, folderState, flagState, rules, contacts, auditLog, accountSyncState, changeLog, threads, messageBodies, routingDecisions, approvals, messageStates, graduations, learningSignals, accounts, users, devices, sessions, refreshTokens, pairingTokens, idempotencyKeys, trackerEvents, contactNotes, threadNotes, snippets, notifyRules, awayResponders, awayResponderSent, attachments, kbEntries, drafts, outboundSends, workflows, workflowRuns, workflowProposals, tags, messageTags, unsubscribeRecords, accountSettings,
};
