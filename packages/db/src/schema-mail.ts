/**
 * The mail-domain schema — the tables a mailbox needs, and the only half that ships. The count's
 * authority is the schema-split test, which asserts it as a literal against this file's
 * declarations. Separate from its Cloud sibling because the journal was split first — a Stripe
 * migration is Cloud logic in SQL and could not stay in a journal that ships — and the one-file
 * TypeScript had a cost no test could see: the local engine imported the whole schema object,
 * carrying credential-hash and billing-ledger columns into a published artifact. The partition is
 * the journal's partition. THE DIRECTION RULE: this file may not import `./schema-cloud.js`,
 * asymmetric on purpose — the mail half must stand alone; the reverse is legal.
 */

import { pgTable, uuid, text, timestamp, bigint, bigserial, boolean, jsonb, integer, real, unique, uniqueIndex, index, primaryKey, customType, check } from "drizzle-orm/pg-core";
import { sql, desc } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0008 — full-text `tsvector`. A DB-MANAGED
// `GENERATED ALWAYS AS (…) STORED` column: Postgres computes it, the app NEVER
// writes it (no `.default`, no insert). We model it as a custom type so TS
// compiles and Drizzle knows the column exists; the generation expression + GIN
// index are core Postgres (safe in PGlite — no CREATE EXTENSION). The
// `to_tsvector('english', …)` regconfig LITERAL is REQUIRED: the default-config
// `to_tsvector(text)` is not IMMUTABLE and a generated column would be rejected.
// ─────────────────────────────────────────────────────────────────────────────
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() { return "tsvector"; },
});

export const mailboxes = pgTable("mailboxes", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  provider: text("provider").notNull(),      // 'imap'
  address: text("address").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  // ── Migration 0007: real mailbox lifecycle fields. Server defaults so
  // the 0006-era rows stay valid on the additive cutover (no backfill needed). ──
  displayName: text("display_name"),                                       // user-facing label (nullable)
  status: text("status").notNull().default("connected"),                   // connected|error|disabled
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),           // last successful worker cycle (nullable)
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
  failedAt: timestamp("failed_at", { withTimezone: true }),                // when the CURRENT outage began (COALESCE on write)
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
  retryAfter: timestamp("retry_after", { withTimezone: true }),
  // ── Mail 0025 — the once-per-mailbox inbox-shaping kickstart ran ──
  //
  // The worker scans the Sent folder at CONNECT, imports its recipients into `contacts` (which
  // IS `knownSenders`) and re-routes the Screener backlog once. This column is the whole of the
  // idempotency: NULL means "never run", a timestamp means "done, never again". It is a MARKER
  // and not a schedule — nothing reads it to decide anything other than skip-or-run, and the
  // worker writes it only AFTER the pass succeeds, so a crash mid-kickstart retries on the next
  // attach rather than leaving a half-shaped mailbox marked complete.
  kickstartAt: timestamp("kickstart_at", { withTimezone: true }),
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
  takeoverAuthorizedAt: timestamp("takeover_authorized_at", { withTimezone: true }),
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
     install per kind — and `apps/worker/src/lease.ts` scopes the Cloud id by environment precisely
     so that two Cloud deployments over one mailbox is a designed-for state. NULL means "we cannot
     say it is ours", and every caller must read it as NOT ours: the release matches on this id
     (`lease.ts`), so a category comparison cleared rows over claims it could not remove. */
  organizedByInstallId: text("organized_by_install_id"),
  organizedSince: timestamp("organized_since", { withTimezone: true }),
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
  organizeConsentedAt: timestamp("organize_consented_at", { withTimezone: true }),
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
  organizerEventAt: timestamp("organizer_event_at", { withTimezone: true }),
  organizerEventSeenAt: timestamp("organizer_event_seen_at", { withTimezone: true }),
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
  releaseRequestedAt: timestamp("release_requested_at", { withTimezone: true }),
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
  organizerReleasedAt: timestamp("organizer_released_at", { withTimezone: true }),
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
  foldersDisabledAt: timestamp("folders_disabled_at", { withTimezone: true }),
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
  // Mail 0098 — the signature's MARKUP half (0.16: Settings gained the compose editor's basic
  // formatting). THE AUTHORITY, and `signature` above is DERIVED from it: when this is non-NULL
  // the server wrote both columns in one statement from one value — `prepareOutboundBody` reduces
  // the posted markup to the compose grammar and renders the text half from what survives, the
  // same pair a `multipart/alternative` promises. Nothing writes `signature` by hand while this
  // is set, so the two cannot drift. NULL is "no markup in this signature" — every pre-column
  // row, and every signature typed without pressing a formatting control; those rows take the
  // pre-0.16 path unchanged, which is what lets every reader of `signature` (the phone's
  // plain-text composer among them) keep working with no knowledge of this. Bounded at the write
  // site with `signature`'s bound, not by a CHECK.
  signatureHtml: text("signature_html"),
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
  junkSweepRequestedAt: timestamp("junk_sweep_requested_at", { withTimezone: true }),
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
  inboundQuietSince: timestamp("inbound_quiet_since", { withTimezone: true }),
  inboundQuietDismissedAt: timestamp("inbound_quiet_dismissed_at", { withTimezone: true }),
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
  syncBlockedSince: timestamp("sync_blocked_since", { withTimezone: true }),
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
  syncRequestedAt: timestamp("sync_requested_at", { withTimezone: true }),
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
  smtpMaxSizeBytes: bigint("smtp_max_size_bytes", { mode: "number" }),
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
  smtpSizeProbedAt: timestamp("smtp_size_probed_at", { withTimezone: true }),
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
  sensitiveRescreenAt: timestamp("sensitive_rescreen_at", { withTimezone: true }),
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
  sensitiveRescreenCursor: uuid("sensitive_rescreen_cursor"),
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
  sensitiveRescreenStartedAt: timestamp("sensitive_rescreen_started_at", { withTimezone: true }),
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
  sensitiveFpBackfillAt: timestamp("sensitive_fp_backfill_at", { withTimezone: true }),
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
  initialImportCompletedAt: timestamp("initial_import_completed_at", { withTimezone: true }),
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
export const mailboxCredentials = pgTable("mailbox_credentials", {
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id),
  transport: text("transport").notNull(),                                  // 'imap'|'smtp'|'graph'
  secretEnc: text("secret_enc").notNull(),                                 // envelope-encrypted, base64url
  keyVersion: integer("key_version").notNull(),                            // KeyProvider KEK version
  meta: jsonb("meta"),                                                     // non-secret conn params (host/port/user/secure)
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.mailboxId, t.transport] }) }));

export const mailboxFolders = pgTable("mailbox_folders", {
  id: uuid("id").defaultRandom().primaryKey(),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id),
  folder: text("folder").notNull(),
  uidvalidity: bigint("uidvalidity", { mode: "bigint" }),
  uidnext: bigint("uidnext", { mode: "bigint" }),
  highestmodseq: bigint("highestmodseq", { mode: "bigint" }),
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uq: unique().on(t.mailboxId, t.folder) }));

/**
 * User-commanded folder operations — mail 0074 (FOLDERS-SPEC.md stage 2). The folder verbs are
 * REAL IMAP writes in the user's own mailbox, and the API never opens IMAP — so it records the
 * COMMAND here, rings the doorbell, and the worker executes it inside the mailbox's serial cycle,
 * applies the database consequences, and DELETES the row. `folder_state`'s desired/observed split
 * lifted one level. `op` is CHECK-closed; `to_folder` is the rename target, NULL otherwise;
 * 'failed' + `error` is the honest refusal, carried to every client; UNIQUE(folder_id) — one
 * command in flight per folder, a second is a 409. A row is deleted on completion; `change_log`
 * carries the history.
 */
export const folderOps = pgTable("folder_ops", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id),
  folderId: uuid("folder_id").notNull().references(() => mailboxFolders.id, { onDelete: "cascade" }),
  op: text("op").notNull(),           // 'create' | 'rename' | 'delete' — CHECK-closed (0074)
  toFolder: text("to_folder"),        // rename target; NULL otherwise — CHECK-paired (0074)
  status: text("status").notNull().default("pending"), // 'pending' | 'failed' — CHECK-closed
  /** Closed refusal code when `status = 'failed'` — a catalogue key, never provider text. */
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uqFolder: unique().on(t.folderId) }));

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id),
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
  date: timestamp("date", { withTimezone: true }),
  nativeLocator: jsonb("native_locator"),     // { folder, ref }
  noAi: boolean("no_ai").notNull().default(false),
  noForward: boolean("no_forward").notNull().default(false),
  noKb: boolean("no_kb").notNull().default(false),
  priority: boolean("priority").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  // ── API display fields + threading (materialized into MessageDTO) ──
  threadId: uuid("thread_id").references(() => threads.id),
  unread: boolean("unread").notNull().default(true),
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
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
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
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  snippet: text("snippet").notNull().default(""),          // sensitivity-redacted preview (never an OTP)
  toAddresses: jsonb("to_addresses").notNull().default(sql`'[]'::jsonb`),   // EmailAddress[]
  ccAddresses: jsonb("cc_addresses").notNull().default(sql`'[]'::jsonb`),   // EmailAddress[]
  hasAttachments: boolean("has_attachments").notNull().default(false),
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  // ── Migration 0008: lexical index over subject + from_address, DB-generated. ──
  subjectTsv: tsvector("subject_tsv").generatedAlwaysAs(
    sql`to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(from_address, ''))`,
  ),
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
  ixSubjectTsv: index("messages_subject_tsv_idx").using("gin", t.subjectTsv),
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
    sql`substring(lower(${t.fromAddress}) from position('@' in lower(${t.fromAddress})) + 1)`,
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
export const messageInstances = pgTable("message_instances", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  folder: text("folder").notNull(),
  uidvalidity: bigint("uidvalidity", { mode: "bigint" }).notNull(),
  uid: integer("uid").notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
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
export const messageFailures = pgTable("message_failures", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id),
  folder: text("folder").notNull(),
  uidvalidity: bigint("uidvalidity", { mode: "bigint" }).notNull(),
  uid: integer("uid").notNull(),
  /** `MessageFailureCode`. A CHECK in the migration closes the set — see the file's header. */
  code: text("code").notNull(),
  attempts: integer("attempts").notNull().default(0),
  /** The build that last attempted this UID. `IS DISTINCT FROM` the running one ⇒ due. */
  attemptedVersion: text("attempted_version"),
  firstFailedAt: timestamp("first_failed_at", { withTimezone: true }).defaultNow().notNull(),
  lastFailedAt: timestamp("last_failed_at", { withTimezone: true }).defaultNow().notNull(),
  /** NULL ⇒ no CLOCK-scheduled retry. The version arm still applies. */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  /** Ingested, or gone from the server, or void under a new epoch. History from here on. */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
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
export const folderState = pgTable("folder_state", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  desiredFolder: text("desired_folder").notNull(),
  observedFolder: text("observed_folder").notNull(),
  lastSetBy: text("last_set_by").notNull(),   // 'us' | 'external'
  reconcileStatus: text("reconcile_status").notNull().default("pending"),
  conflict: boolean("conflict").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  /** Refusals recorded for this move. See the block above. */
  attempts: integer("attempts").notNull().default(0),
  /** NULL ⇒ due now. See the block above. */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  /**
   * WHY the last attempt was refused — one of `refused | no_such_folder | read_only |
   * over_quota`, NULL while no refusal stands. A CLASS, not the free text the block above
   * forbids; {@link RECONCILE_REFUSAL_CLASSES} in `apps/worker/src/sync.ts` holds the mapping and
   * the CHECK's membership. Written by the deferral and cleared by a fresh intent, alongside the
   * schedule pair — one group, because a class without its schedule is a reason for nothing and a
   * schedule without its class is the sentence this column exists to end. A TRANSPORT failure
   * writes NEITHER: an unreachable mail host is not this message's refusal.
   */
  lastErrorClass: text("last_error_class"),
  /**
   * Where a deleted message came from — the origin a restore puts it back to (mail 0099). Written
   * by the DELETE verb alone: the value is `observed_folder` as it stood at the press; NULL when
   * that already equalled Trash. CLEARED BY EVERY NON-TRASH DESIRED WRITE: a message filed out of
   * Trash and later deleted elsewhere must not inherit its previous life's origin;
   * `upsertDesired` takes the value as an argument, so a caller cannot write `desired_folder`
   * without saying what this becomes. A path, never trusted: `restore` resolves it and falls back
   * to INBOX — no CHECK, no FK. NOT a `change_log` read: the log has a retention horizon — a
   * restore would work for a week, then silently stop.
   */
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
export const flagState = pgTable("flag_state", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  desiredSeen: boolean("desired_seen").notNull(),
  observedSeen: boolean("observed_seen").notNull(),
  lastSetBy: text("last_set_by").notNull(),   // 'us' | 'external'
  reconcileStatus: text("reconcile_status").notNull().default("pending"),
  conflict: boolean("conflict").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  /** Refusals recorded for this `\Seen` write — `folder_state`'s pair, same rules. */
  attempts: integer("attempts").notNull().default(0),
  /** NULL ⇒ due now. See the block above `folderState`. */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
}, (t) => ({ uqMessage: unique().on(t.messageId) }));

export const rules = pgTable("rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  kind: text("kind").notNull(),               // 'sender' | 'domain' | 'header'
  match: text("match").notNull(),
  destination: text("destination").notNull(), // one of the six canonical folders
  priority: integer("priority").notNull().default(0),
  provenance: text("provenance").notNull().default("manual"), // manual | migrated | promoted
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  // ── RuleDTO.stats ──
  hits: integer("hits").notNull().default(0),
  lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
  demotions: integer("demotions").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),

  /**
   * Mail 0034 — applying a rule to mail that is ALREADY filed. The default: creating a rule
   * applies it to all messages, future and previous. `retro_requested_at` set with
   * `retro_done_at` NULL is the ONE definition of owed work. `retro_done_at` is written LAST
   * (claiming first makes a crash permanent); re-running is safe because the candidate query is
   * the idempotency. `retro_cursor` is the resume point, ACCOUNT-scoped. Known limit:
   * `messages.id` is a random UUID, so a message ingested after the cursor passed its id is
   * skipped forever — acceptable; a rule routes new mail at arrival. `retro_moved` is reported,
   * not read. These columns ship to the desktop engine where nothing writes them yet.
   */
  retroRequestedAt: timestamp("retro_requested_at", { withTimezone: true }),
  retroDoneAt: timestamp("retro_done_at", { withTimezone: true }),
  retroCursor: uuid("retro_cursor"),
  retroMoved: integer("retro_moved").notNull().default(0),

  /**
   * Mail 0050 — a second term on a sender rule: the SUBJECT. One sender sends two kinds of mail
   * (`info@` is the invoice AND the nightly alert), and a sender rule could only file all of it
   * together. NULL is the resting state, "no subject term"; there is no backfill and can never be
   * one: a term invented for an existing rule would NARROW a decision the user made about a whole
   * sender. A CONJUNCTION: `matches` reads it as an extra term, so a present term can only make a
   * rule fire LESS often; an older engine keeps matching on the sender alone. It changes the
   * ORDER: a subject-carrying rule OUTRANKS a bare rule for the same address. The CHECK forbids
   * empty and whitespace-only; the 200-char ceiling refuses a haystack as a needle.
   */
  subjectContains: text("subject_contains"),

  /**
   * Mail 0052 — the other half of the same requirement: the MESSAGE TEXT. Some senders write the
   * SAME subject on every message and put the distinguishing text in the body; the same
   * conjunction one field deeper. The 0050 comment holds: NULL is the resting state, no backfill
   * ever, an extra term above the kind switch, the CHECK makes NULL the only spelling of "no
   * term". The haystack is the canonical PLAIN TEXT — `NormalizedMessage.textBody`,
   * byte-identical to `message_bodies.text`, which the retro passes read back, so arrival and
   * retro consult the SAME haystack. A body not on disk reads as `""`, satisfying no term —
   * fail-closed. Rank: both terms, subject-only, body-only, bare. Same 200-char ceiling.
   */
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

export const contacts = pgTable("contacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  address: text("address").notNull(),         // lowercased sender address = "known sender"
  // ── Migration 0010: user-editable display name for the reference
  // card (PATCH /contacts/:id { name }). Nullable — a contact begins as a bare
  // address the pipeline recorded; the user may later name it. ──
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uq: unique().on(t.accountId, t.address) }));

export const auditLog = pgTable("audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  action: text("action").notNull(),
  payload: jsonb("payload"),
  inverse: jsonb("inverse"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Delta change-log. The single mechanism every client-visible
// mutation writes to. Per-account monotonic, gap-free `seq` allocated from a
// counter row locked inside each mutation's transaction.
// ─────────────────────────────────────────────────────────────────────────────

export const accountSyncState = pgTable("account_sync_state", {
  accountId: uuid("account_id").primaryKey(),           // one row per account; the seq source of truth
  nextSeq: bigint("next_seq", { mode: "bigint" }).notNull().default(sql`0`),
});

export const changeLog = pgTable("change_log", {
  accountId: uuid("account_id").notNull(),
  seq: bigint("seq", { mode: "bigint" }).notNull(),     // assigned via allocateSeq(tx, accountId); PART OF PK
  entityType: text("entity_type").notNull(),            // EntityType (message|thread|routing_decision|approval|…)
  entityId: uuid("entity_id").notNull(),
  op: text("op").notNull(),                             // create|update|move|delete
  meta: jsonb("meta"),                                  // move: {from,to}; else null
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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

export const threads = pgTable("threads", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  subject: text("subject").notNull().default(""),
  participants: jsonb("participants").notNull().default(sql`'[]'::jsonb`),  // EmailAddress[]
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  muted: boolean("muted").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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

export const messageBodies = pgTable("message_bodies", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull().references(() => messages.id),  // 1:1
  text: text("text").notNull().default(""),             // the FULL original body text (no redaction)
  html: text("html"),
  headers: jsonb("headers").notNull().default(sql`'{}'::jsonb`),
  loadedRemoteContent: boolean("loaded_remote_content").notNull().default(false),
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
  bodyTsv: tsvector("body_tsv").generatedAlwaysAs(
    sql`to_tsvector('english', coalesce(text, ''))`,
  ),
}, (t) => ({
  uqMessage: unique().on(t.messageId),
  ixBodyTsv: index("message_bodies_body_tsv_idx").using("gin", t.bodyTsv),
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
 * Mail 0062: per-account stored-body bytes — the storage cap's ledger. One row per account:
 * `octet_length(text) + octet_length(html)` over `message_bodies`, maintained in the SAME
 * transaction as every body write (ingest, the repair passes, erasure), so the number can never
 * describe a state the table is not in. What does NOT count: `headers` (still written at cap —
 * undeclinable bytes would grow with no remedy), snippets, drafts, attachment metadata, staging —
 * the user-facing sentence is "mail body storage", never "storage". A maintained counter, not an
 * aggregate: the sum has no index over the largest table. Lock order (pinned by a pg test): the
 * `account_storage` row is written BEFORE the first `recordChange` in any transaction.
 */
export const accountStorage = pgTable("account_storage", {
  accountId: uuid("account_id").primaryKey(),
  // bigint: a mailbox measured in bytes outruns int4 at 2 GiB, which is an ordinary mailbox.
  bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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

export const routingDecisions = pgTable("routing_decisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  inputProvenance: text("input_provenance").notNull(),  // 'rule'|'header'|'screener'|'ai'
  matchedRuleId: uuid("matched_rule_id"),
  destination: text("destination").notNull(),           // a Destination
  confidence: real("confidence"),        // 0..1 (AI) or null (deterministic)
  rationale: text("rationale"),
  spam: boolean("spam").notNull().default(false),
  status: text("status").notNull(),                     // auto_applied|pending_approval|approved|rejected
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ix: index("routing_decisions_account_message_idx").on(t.accountId, t.messageId) }));

export const approvals = pgTable("approvals", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  kind: text("kind").notNull(),                         // 'routing' (current); draft_send / workflow_action (later kinds)
  messageId: uuid("message_id"),
  routingDecisionId: uuid("routing_decision_id"),
  action: text("action").notNull(),
  summary: text("summary").notNull().default(""),
  payload: jsonb("payload"),                            // executable payload
  confidence: real("confidence"),
  status: text("status").notNull().default("pending"),  // pending|approved|rejected|expired
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ix: index("approvals_account_status_idx").on(t.accountId, t.status) }));

export const messageStates = pgTable("message_states", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  // none|reply_later|set_aside|bubbled_up|muted|resurfaced. `resurfaced` is NOT a bottom pile —
  // it pins the row at the top of the Ohbox, and it is written both by the worker's bubble-up
  // pass when a schedule comes due and directly by "Resurface now". Free text, no CHECK: the
  // closed set lives in `services/src/dto/types.ts#TriageState`.
  state: text("state").notNull().default("none"),
  // Set for state='bubbled_up' and NULL for every other state, including 'resurfaced' — the
  // worker's due-scan selects on this column, so a date left on a resurfaced row is a second
  // flip waiting to happen.
  bubbleUpAt: timestamp("bubble_up_at", { withTimezone: true }),
  setAt: timestamp("set_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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

export const graduations = pgTable("graduations", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  patternKey: text("pattern_key").notNull(),       // e.g. "sender:a@b.com→INBOX" | "domain:b.com→Feed"
  action: text("action").notNull().default("route"),
  positives: integer("positives").notNull().default(0),
  negatives: integer("negatives").notNull().default(0),
  graduated: boolean("graduated").notNull().default(false),
  graduatedAt: timestamp("graduated_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uq: unique().on(t.accountId, t.patternKey, t.action) }));

// ─────────────────────────────────────────────────────────────────────────────
// Learning signals. Every learning-relevant action
// (screener yes/no, approval approve/reject, adopted external move) is captured
// here EXACTLY once, deduped by `triggeringActionId`. The UNIQUE
// (accountId, triggeringActionId) + ON CONFLICT DO NOTHING is the dedup gate:
// a graduation counter is advanced only when a signal is NEWLY inserted, so a
// replayed action never double-counts.
// ─────────────────────────────────────────────────────────────────────────────

export const learningSignals = pgTable("learning_signals", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  triggeringActionId: text("triggering_action_id").notNull(),  // "screener:<id>" | "approval:<id>" | "move:<msgId>:<seq>"
  kind: text("kind").notNull(),                                // 'screener'|'approval'|'override'|'external_move'
  senderAddress: text("sender_address"),
  senderDomain: text("sender_domain"),
  destination: text("destination"),                            // a Destination
  label: text("label").notNull(),                              // 'positive'|'negative'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
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
  aiEnabled: boolean("ai_enabled").notNull().default(true),
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
  aiAnsweredAt: timestamp("ai_answered_at", { withTimezone: true }),
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
  erasedAt: timestamp("erased_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
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
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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

export const devices = pgTable("devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),                    // 'web' | 'macos'
  label: text("label").notNull().default(""),
  ip: text("ip").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  // mail 0064 — when this device's `/sync` read last reached the horizon (`hasMore: false`).
  // NULL = never completed a drain. Stamped by the API's sync route alone, throttled in the
  // statement; the `device_sync_stale` alert reads it. Never projected into a DTO.
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
}, (t) => ({ ixUser: index("devices_user_idx").on(t.userId) }));

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id),
  deviceId: uuid("device_id").references(() => devices.id),
  familyId: uuid("family_id").notNull(),           // refresh-token family (reuse detection)
  accessTokenHash: text("access_token_hash"),
  // Privilege scope: 'full' = a completed two-factor login.
  // 'enrollment' = the short-lived password-only session minted at register (or at
  // a re-entry login by a user with ZERO enrolled 2FA methods). It reaches only the
  // `enrollmentOk` routes and is REVOKED the moment a first factor is enrolled.
  // CHECK-constrained to those two values so an unknown scope cannot exist.
  scope: text("scope").default("full").notNull(),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
  lastTwofaAt: timestamp("last_twofa_at", { withTimezone: true }),   // step-up 5-min window
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  // mail 0070 — when this session's `/sync` read last reached the horizon (the empty tail).
  // NULL = never completed a drain. The per-SESSION twin of `devices.last_synced_at` (0064):
  // a deviceless install (the browser-door desktop, a plain web tab) has no device row, so
  // this is the only place its convergence can be recorded. Stamped by the API's sync route
  // alone, throttled in the statement; the `session_sync_stale` alert reads it beside
  // `last_seen_at` (still requesting + not converging = a wedged mirror). Never in a DTO.
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
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
export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id),
  sessionId: uuid("session_id").notNull().references(() => sessions.id),
  familyId: uuid("family_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
export const pairingTokens = pgTable("pairing_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  grant: text("grant").notNull(),                  // 'invite' | 'device-pair' (CHECK in 0059)
  tokenHash: text("token_hash").notNull(),         // sha256(raw); the raw value is never at rest
  label: text("label").notNull().default(""),      // device-pair: becomes the device row's label
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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

export const idempotencyKeys = pgTable("idempotency_keys", {
  accountId: uuid("account_id").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),          // sha256(method\npath\nrawBody) hex
  responseStatus: integer("response_status").notNull(),
  responseJson: jsonb("response_json").notNull(),       // the stored response body, replayed verbatim
  seq: bigint("seq", { mode: "number" }),               // change_log seq to re-emit as X-Sync-Seq (null if none)
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),   // created_at + 24h (lazy cleanup)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
export const trackerEvents = pgTable("tracker_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  kind: text("kind").notNull(),                    // 'pixel'|'remote_image'|'read_receipt'
  trackerHost: text("tracker_host"),               // who tried to spy (nullable)
  url: text("url"),                                 // the original remote url (nullable)
  detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
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

export const contactNotes = pgTable("contact_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  contactId: uuid("contact_id").notNull().references(() => contacts.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ix: index("contact_notes_account_contact_idx").on(t.accountId, t.contactId) }));

export const threadNotes = pgTable("thread_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  threadId: uuid("thread_id").notNull().references(() => threads.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ix: index("thread_notes_account_thread_idx").on(t.accountId, t.threadId) }));

export const snippets = pgTable("snippets", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  shortcut: text("shortcut"),                  // optional typeahead trigger (nullable)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ix: index("snippets_account_idx").on(t.accountId) }));

export const notifyRules = pgTable("notify_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  target: text("target").notNull(),            // the sender/domain/keyword/thread spec to notify on
  kind: text("kind").notNull().default("sender"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ix: index("notify_rules_account_idx").on(t.accountId) }));

export const awayResponders = pgTable("away_responders", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  subject: text("subject"),
  body: text("body"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
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
   * WHICH PILES ARE ANSWERED — `'{INBOX}'` by default (mail 0096), as FOLDER names.
   *
   * The second, independent dimension beside {@link audience}, and the two answer different
   * questions on purpose. `audience` is a fact about a SENDER — past the Screener, decided once,
   * true for ever — and it cannot express "answer this person's mail when it reaches me, but not
   * when it files itself away". That gap is what sent eight automatic replies to shop and
   * notification senders who had each been let in once, months earlier.
   *
   * MEMBERS ARE FOLDERS, NOT PILE WORDS. The pile a person calls "Ohbox" is `INBOX`
   * (`VIEW_OF_FOLDER` in client-engine maps the six destinations onto the six words); there is no
   * `ohmail/Ohbox`, and this feature's own fixture carried that string for three cases before
   * anything read it. The value compared at decision time is `folder_state.desired_folder`, which
   * holds a destination, so this column holds destinations.
   *
   * The closed set is `{INBOX, ohmail/Reads}` and the CHECK
   * (`away_responders_piles_closed`) lives in the migration, for `audience`'s reason: an
   * unhandled member is resolved by whichever branch the rule falls through to, and here that is
   * the branch that sends mail. `ohmail/Receipts`, `ohmail/Screened` and `ohmail/Quarantine` are
   * refused by the never-answered map in `away-eligibility.ts`; `ohmail/Screener` is deliberately
   * not a member, because it is the AUDIENCE's decision and two settings ruling on one population
   * is a contradiction whichever is consulted second.
   *
   * NOT NULL with a default, and the default is the NARROW member — unlike `throttle`, whose
   * default is the middle of its range. Widening what a standing order reaches is the only
   * irreversible thing this feature does, so the value nobody chose is the one that reaches
   * fewest people. An EMPTY array is representable and means "answer nobody", which the rule
   * handles by name rather than reading as "no filter".
   */
  piles: text("piles").array().notNull().default(["INBOX"]),
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
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uqAccount: unique().on(t.accountId) }));   // one row per account ⇒ PUT upserts

/**
 * One automatic reply per sender, and the row that proves it — keyed `(account, sender,
 * episode)`; the UNIQUE is the guard. The episode key is the responder row's own `updated_at`: a
 * boolean "replied" flag would permanently silence every first-trip correspondent after an
 * off-and-on. Stated: ANY edit is a new episode, so a mid-trip typo fix may answer a
 * correspondent twice — deliberate, because twice is recoverable and never is not. Written BEFORE
 * the send: SMTP is not transactional, so claiming first costs a crash ONE unsent reply. `ON
 * CONFLICT DO NOTHING` returning zero rows IS the already-answered branch. `sender` is the
 * lowercased envelope author; no FK to `messages` — an expunge must not un-answer a sender.
 */
export const awayResponderSent = pgTable("away_responder_sent", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  sender: text("sender").notNull(),
  responderUpdatedAt: timestamp("responder_updated_at", { withTimezone: true }).notNull(),
  /** The message that triggered it, as evidence. Nullable, NO foreign key — see the header. */
  messageId: uuid("message_id"),
  /** The minted `<uuid@domain>` of the reply we sent, so a Sent-folder copy is attributable. */
  mintedMessageId: text("minted_message_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
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
export const awayReplies = pgTable("away_replies", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  /** The mailbox the message ARRIVED in — the identity the reply is sent from. */
  mailboxId: uuid("mailbox_id").notNull(),
  /** The message that triggered it. NO foreign key — see the header. */
  messageId: uuid("message_id").notNull(),
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
  decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
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
export const awaySenderState = pgTable("away_sender_state", {
  accountId: uuid("account_id").notNull(),
  /** The lowercased envelope author. Half of the primary key, and the throttle's subject. */
  sender: text("sender").notNull(),
  /** When this person was last answered. NOT NULL: a row exists only because one was sent. */
  lastRepliedAt: timestamp("last_replied_at", { withTimezone: true }).notNull(),
  /** The `awayTextHash` of what they were told — what `per_message` compares against. */
  lastTextHash: text("last_text_hash").notNull(),
  /**
   * When a bounce for an away reply to this person came back (mail 0096) — after which no further
   * automatic reply is ever sent to them. A delivery report is refused as a candidate in its own
   * right, so the bounce never earned a reply; what was missing is what it MEANS: the address the
   * responder wrote to does not accept mail. Without this, the next message from the same
   * correspondent produced another reply and another bounce, once per throttle interval for the
   * length of the trip. On THIS table rather than the ledger because it is a fact about a PERSON,
   * not one decision. A stamp, not a boolean: "when did we learn this" costs the same. Permanent,
   * no expiry: the recoverable direction is silence — the alternative is the bounce loop.
   */
  undeliverableAt: timestamp("undeliverable_at", { withTimezone: true }),
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
export const organizerRequests = pgTable("organizer_requests", {
  /** Also the `X-Ohmail-Request-Id` of the appended record — the two identities are one. */
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  /** The mailbox the decision is about. NO foreign key — see the header. */
  mailboxId: uuid("mailbox_id").notNull(),
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
  payload: jsonb("payload").notNull(),
  /**
   * WHEN THE PERSON DECIDED, by the deciding door's clock. The drain applies in this order, so two
   * doors deciding one sender within one cycle land in the order the human made them rather than
   * in the order the IMAP server happens to list them.
   */
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  /** One of the FIVE states. Closed by `organizer_requests_state_closed`. */
  state: text("state").notNull().default("pending"),
  /** When it was appended to the mailbox. NULL while `pending`. */
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** When it became `applied`, `refused` or `expired`. NULL before that. */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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

/**
 * What the organizer says the configuration is — a reader's copy of the profile document (mail
 * 0094). The organizer publishes a versioned document into `ohmail/_meta`; this is the last one a
 * READER managed to read: one row per mailbox, replaced whole, never merged. A MIRROR, never a
 * source: nothing organizes from this table. It exists so a reader's settings panes render what
 * the HOLDER's configuration actually is, rather than the reader's own row — which the organizer
 * never reads. NO ROW is a state, and not the same as an empty one: a reader that has never read
 * a document must render "no profile from the holder yet", not a configuration with nothing in it
 * — identical in a table of defaults, opposite in meaning.
 */
export const mailboxProfileMirror = pgTable("mailbox_profile_mirror", {
  /**
   * The mailbox IS the identity of the document, so it is the key rather than a surrogate with a
   * unique index beside it. Two mirrors of one mailbox is not a state this feature has.
   */
  mailboxId: uuid("mailbox_id").primaryKey(),
  /** WHOSE. Account isolation is a column here, not a convention a caller remembers to join for. */
  accountId: uuid("account_id").notNull(),
  /**
   * The server epoch {@link uid} was read under — stored because a remembered IMAP uid is a fact
   * only under its UIDVALIDITY: a renumbered folder re-issues the same small integers to
   * different messages, and a memo that survived the renumber points confidently at the wrong
   * one. Every other locator in this schema is keyed the same way
   * (`message_instances_locator_uq`, `message_failures_locator_uq`); 0028 states the rule — one
   * UID inside one server epoch is one place. NULL means the reader could not learn the
   * generation, which reads as "this locator is not usable" and never as "any generation will
   * do".
   */
  uidvalidity: bigint("uidvalidity", { mode: "bigint" }),
  /** The message the document was read from, inside that epoch. */
  uid: integer("uid"),
  /** THE DOCUMENT AS PARSED, envelope included — so a reader sees the version and producer that
      wrote it rather than inferring them. */
  doc: jsonb("doc").notNull(),
  /**
   * WHEN THIS INSTALL LAST READ IT. The pane says "as of <t>" from this; a reader that has been
   * offline for a day has to be able to say so rather than present a day-old document as current.
   */
  readAt: timestamp("read_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // THE ERASURE SWEEP'S READ, and the isolation census's. Both ask by ACCOUNT, and the primary key
  // leads with the mailbox, so it does not serve them.
  ixAccount: index("mailbox_profile_mirror_account_idx").on(t.accountId),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0011 — attachment METADATA only. The BLOB bytes are NEVER
// stored server-side: this table holds filename/contentType/size
// + the IMAP `part_id` the on-demand fetch uses, and the bytes are streamed live
// from IMAP (`GET /attachments/:id`). Rows are written in the SAME transaction as
// their `messages` row at ingest (atomic — no orphan attachment without its
// message). `inline` marks a `related` (cid:) embedded image vs a real file.
// ─────────────────────────────────────────────────────────────────────────────
export const attachments = pgTable("attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  filename: text("filename"),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  partId: text("part_id"),                                  // IMAP MIME body-part number (on-demand fetch key)
  contentId: text("content_id"),                            // for inline (cid:) parts
  inline: boolean("inline").notNull().default(false),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
export const kbEntries = pgTable("kb_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),   // string[]
  // ── Migration 0015: the per-step crash-resume dedup key. When a
  // workflow `add_kb_entry` step writes this row it stamps `${runId}:${stepIndex}`
  // here; the UNIQUE (nullable ⇒ many NULLs allowed) + ON CONFLICT DO NOTHING means a
  // re-drain of the SAME run never inserts a second KB entry. NULL for user-authored
  // entries (the common case). ──
  workflowDedupKey: text("workflow_dedup_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  // DB-generated lexical index over title + content (regconfig LITERAL pinned so the
  // generation expression is IMMUTABLE, like 0008). The app NEVER writes it.
  kbTsv: tsvector("kb_tsv").generatedAlwaysAs(
    sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))`,
  ),
}, (t) => ({
  ixAccount: index("kb_entries_account_idx").on(t.accountId),
  ixKbTsv: index("kb_entries_kb_tsv_idx").using("gin", t.kbTsv),
  uqWfDedup: unique("kb_entries_workflow_dedup_key_unique").on(t.workflowDedupKey),   // per-step idempotency
}));

export const drafts = pgTable("drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id),   // the mailbox this draft sends from
  threadId: uuid("thread_id").references(() => threads.id),                  // reply target thread (nullable)
  inReplyToMessageId: uuid("in_reply_to_message_id").references(() => messages.id),  // nullable
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  // ── Migration 0037: the RICH half. NULL means "this draft is plain text", which is the
  // truth for every draft written before rich compose and for every one a client that does not
  // send html writes afterwards. `body` is never derived away — when `html` is present it holds
  // the text/plain alternative derived from it, so the two parts of the multipart cannot drift
  // and a code path that predates this column still sends the right words. Sanitized by
  // `sanitizeOutboundHtml` before it is written; capped at 256 KiB by `drafts_html_cap`. ──
  html: text("html"),
  to: jsonb("to").notNull().default(sql`'[]'::jsonb`),   // EmailAddress[]
  cc: jsonb("cc").notNull().default(sql`'[]'::jsonb`),   // EmailAddress[]
  // Migration 0045. Bcc rides the SMTP ENVELOPE ONLY — `SendService.reserve` copies it into
  // `OutboundMessage.bcc` and nodemailer never writes a Bcc header into the message or the Sent
  // copy. Stored here (not just on the create request) because the send is a second, recipient-less
  // request that reads this row to build the envelope. ──
  bcc: jsonb("bcc").notNull().default(sql`'[]'::jsonb`),   // EmailAddress[]
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
  sendAt: timestamp("send_at", { withTimezone: true }),
  sendKey: text("send_key"),
  sendError: text("send_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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
export const outboundSends = pgTable("outbound_sends", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  // Mail 0095 — NULLABLE, `ON DELETE SET NULL`: which draft the attempt was ABOUT, a question
  // that stops being answerable when the person discards the text. The reservation's identity is
  // `UNIQUE(account_id, idempotency_key)` — the replay gate — and that gate does not mention this
  // column, so the record of the attempt outlives the draft. It was `NOT NULL … NO ACTION`, which
  // made `DraftsService.remove` answer 409 for ANY row here (23503, measured): a draft whose send
  // definitively failed was undeletable, permanently. A `pending` row cannot be orphaned:
  // `pending` is inside `sendOnRecord`, so the delete is refused while one exists, under a `FOR
  // UPDATE` that serializes against the reservation's own lock — that matters because the
  // reconcile pass reaches its rows through `INNER JOIN drafts`, and a NULL here would be
  // invisible to the reconciler AND the stuck-send alarm.
  draftId: uuid("draft_id").references(() => drafts.id, { onDelete: "set null" }),
  mintedMessageId: text("minted_message_id").notNull(),      // `<uuid@domain>` minted up front
  providerMessageId: text("provider_message_id"),            // the delivered Message-ID (null until sent)
  status: text("status").notNull().default("pending"),       // pending|sent|failed|unverified
  sentAt: timestamp("sent_at", { withTimezone: true }),
  // ── Mail 0095 — WHO settled an ambiguous attempt, and WHEN. `'person'` is the only value any
  // build writes: a reader who looked in their Sent folder and told us what they found. The
  // distinction this records is testimony vs observation — a send the reconciler finalized and one
  // a person resolved both end at `status = 'sent'`, and a later reader has to be able to tell
  // those apart. Free text rather than CHECK-closed so the first other resolver is not an
  // unwritable row on the day it ships; tainted in the content census for that reason, and
  // deliberately outside the column-scoped `ohmail_admin` grant (no staff surface reads it).
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uqKey: unique().on(t.accountId, t.idempotencyKey),         // the per-account idempotency reservation gate
}));

// A claim on the CONTENT of a send — the duplicate defence that does not depend on the client
// keeping its key. The client key on `outbound_sends` fails one measured way: a fresh key AND a
// fresh draft row collides with nothing (a reinstall, a second device, a cleared store). So the
// account also claims the content: `fingerprint` is SHA-256 over what a recipient can perceive —
// address lists, subject, sent text, targets, schedule, an attachment manifest — deliberately NOT
// the draft id (the field the defect moves), the thread, the minted Message-ID, the key or the
// mailbox. A TABLE, not a column: the claim is RE-POINTABLE while each reservation is permanent.
// The window is enforced at the DECISION, never by the prune: the sidecar runs this same
// `reserve` with no maintenance pass, so a prune-enforced window would refuse identical re-sends
// forever. `account_id` carries no FK: the mail journal must run first against an empty database.
export const outboundSendFingerprints = pgTable("outbound_send_fingerprints", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  mailboxId: uuid("mailbox_id").notNull(),
  /** SHA-256 of the canonical member list, lowercase hex — closed by shape, never free text. */
  fingerprint: text("fingerprint").notNull(),
  /** The reservation that currently owns this content. Re-pointed on a reclaim. */
  /**
   * CASCADE — a claim has no meaning without the reservation it points at.
   *
   * A plain reference blocked every path that removes a reservation, and there are three: the
   * desktop mirror wipe, the local mirror's per-draft cleanup, and account erasure. All failed
   * 23503; the desktop's handler catches its own failure and answers 200, so a mailbox removal
   * looked successful while leaving the rows behind, and re-adding it showed the old mail twice.
   * Erasure failed outright.
   */
  sendId: uuid("send_id").notNull().references(() => outboundSends.id, { onDelete: "cascade" }),
  /** Restamped on a reclaim — this is the window's clock, not the row's birthday. */
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uqContent: unique("outbound_send_fingerprints_content_uq").on(t.accountId, t.mailboxId, t.fingerprint),
  // Declared here to keep the TS schema honest; the constraint is created by the migration. The
  // column is machine-generated and closed by SHAPE, which is what keeps it out of the operator
  // console's taint sweep — the argument mail 0091 made for `organizer_requests.refused_reason`.
  ckFingerprint: check(
    "outbound_send_fingerprints_hex",
    sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`,
  ),
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
export const workflows = pgTable("workflows", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  name: text("name").notNull(),
  trigger: jsonb("trigger").notNull().default(sql`'{}'::jsonb`),   // WorkflowTrigger {kind:'manual'|'time'|'event', nextRunAt?, match?}
  steps: jsonb("steps").notNull().default(sql`'[]'::jsonb`),       // WorkflowStep[]
  enabled: boolean("enabled").notNull().default(false),            // enabling IS the consent
  provenance: text("provenance").notNull().default("user"),        // proposed|user|graduated
  deletedAt: timestamp("deleted_at", { withTimezone: true }),      // soft-delete marker
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ixAccount: index("workflows_account_idx").on(t.accountId) }));

export const workflowRuns = pgTable("workflow_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  workflowId: uuid("workflow_id").references(() => workflows.id),   // NULLABLE — retain runs past a soft-delete
  status: text("status").notNull().default("pending"),             // pending|running|awaiting_approval|succeeded|failed|undone
  trigger: jsonb("trigger").notNull().default(sql`'{}'::jsonb`),   // snapshot of the workflow trigger at enqueue
  log: jsonb("log").notNull().default(sql`'[]'::jsonb`),           // per-step convenience index (canonical inverse = audit_log)
  stepCursor: integer("step_cursor").notNull().default(0),         // durable resume cursor
  reason: text("reason"),                                          // failure/skip reason (nullable)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
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
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
}, (t) => ({ ixAccountStatus: index("workflow_runs_account_status_idx").on(t.accountId, t.status) }));

// Migration 0016 — AI workflow PROPOSALS. The proposer reads NON-SENSITIVE pattern metadata only
// (sender/domain/destination/count/provenance from learning signals, routing decisions and rules
// — never bodies or snippets) and stores suggested automations here. A proposal is INERT: never a
// workflow until the user explicitly materializes it (`POST /workflows { fromProposalId }`),
// which creates a `provenance='proposed', enabled=false` row — never auto-enabled. REST-only: no
// `change_log`/`EntityType` growth; clients refetch. `sourcePattern` records the redacted
// metadata the suggestion was derived from (audit/UI only). `status` open|materialized|dismissed.
export const workflowProposals = pgTable("workflow_proposals", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  name: text("name").notNull(),
  rationale: text("rationale").notNull().default(""),
  trigger: jsonb("trigger").notNull().default(sql`'{}'::jsonb`),   // WorkflowTrigger
  steps: jsonb("steps").notNull().default(sql`'[]'::jsonb`),       // WorkflowStep[] (allowlisted tools only)
  sourcePattern: jsonb("source_pattern"),                          // redacted WorkflowPattern metadata (nullable)
  status: text("status").notNull().default("open"),                // open|materialized|dismissed
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ ixAccountStatus: index("workflow_proposals_account_status_idx").on(t.accountId, t.status) }));

// Migration 0031 — TAGS. Ours, never IMAP. A tag is a row in OUR store, keyed by message — never
// an IMAP folder: ohmail organizes the mailbox in place with exactly the fixed `ohmail/*` set
// plus INBOX, and a tag is a cross-cutting dimension OVER those places, not a seventh place; tags
// as folders would also mean a per-message IMAP COPY, which leave-anytime refuses. The honest
// consequence, stated in the UI: a tag lives only here, so it survives a disconnect (a soft
// delete, reversible) but not account erasure, and it does not outlive its message. NO
// `class_name` column: a CSS class is not account data and a server has no business minting one —
// `hue` is the stored dimension and the client maps it.
export const tags = pgTable("tags", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  name: text("name").notNull(),
  hue: text("hue").notNull().default("moss"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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
export const messageTags = pgTable("message_tags", {
  accountId: uuid("account_id").notNull(),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  tagId: uuid("tag_id").notNull().references(() => tags.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
export const unsubscribeRecords = pgTable("unsubscribe_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  mailboxId: uuid("mailbox_id").notNull().references(() => mailboxes.id),
  listKey: text("list_key").notNull(),
  /** 'claimed' | 'sent' | 'refused' | 'failed' — closed by a CHECK in the migration. */
  state: text("state").notNull(),
  /** Which refusal, when `state='refused'`. Null otherwise. */
  refusal: text("refusal"),
  /** The sender's HTTP status when `state='sent'`, including a non-2xx. Null otherwise. */
  httpStatus: integer("http_status"),
  /** The message that supplied the URL — evidence for why this list was left. */
  messageId: uuid("message_id").notNull().references(() => messages.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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
export const accountSettings = pgTable("account_settings", {
  accountId: uuid("account_id").primaryKey(),
  /** Cutline dial, in days. NULL = the product default. CHECK (> 0) lives in the migration. */
  dormancyDays: integer("dormancy_days"),
  /** When the sent-mail seed review was confirmed. THE consent event of onboarding. */
  seedConfirmedAt: timestamp("seed_confirmed_at", { withTimezone: true }),
  /** Senders that confirm covered, and how many were unchecked first. Reported, never read. */
  seedConfirmedCount: integer("seed_confirmed_count").notNull().default(0),
  seedDeclinedCount: integer("seed_declined_count").notNull().default(0),
  /** When screening state was last wiped. A supported operation, so it is account state. */
  screeningResetAt: timestamp("screening_reset_at", { withTimezone: true }),
  /**
   * Auto-suggest for new senders — when the account opted in, or NULL for off (mail 0040). ON
   * means: while the Screener is open, ohmail buys a classifier suggestion for the senders at the
   * front of the queue, so each stranger arrives with a verdict and a reason. It does NOT decide
   * — no rule, no move, no `change_log` row; a stranger still waits for a human. The opt-in
   * exists because a suggestion is a METERED action: this flag authorises spending the account's
   * credits without a per-batch click, nothing else. NULL, "no row", and a FAILED settings read
   * must all read as OFF — defaulting the other way would spend money on a fetch error. A
   * timestamp, read as `IS NOT NULL`, never as a deadline.
   */
  autoSuggestAt: timestamp("auto_suggest_at", { withTimezone: true }),
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
   * The Ohbox backlog tidy — the resumable, re-armable marker for the worker pass that re-routes
   * mail ALREADY misfiled into the Ohbox under `people_only` (mail 0043). New mail is demoted
   * live; these are the retroactive clean-up's durable state — `rules.retro_*` lifted to a
   * per-ACCOUNT marker. `requested_at`: stamped ONLY on the transition INTO `people_only`, with
   * the cursor NULLed in the same UPDATE — re-arming without resetting the cursor would resume at
   * the end and move nothing. `done_at`: written LAST (claiming first makes a crash permanent);
   * owed = requested and not yet done since. `cursor`: the last `messages.id` of the last
   * COMMITTED page. NULL on every existing account: shipping the columns moves no mail.
   */
  ohboxTidyRequestedAt: timestamp("ohbox_tidy_requested_at", { withTimezone: true }),
  ohboxTidyDoneAt: timestamp("ohbox_tidy_done_at", { withTimezone: true }),
  ohboxTidyCursor: uuid("ohbox_tidy_cursor"),
  /**
   * Screener auto-apply — when the account opted in, or NULL for off (mail 0046). ON means: the
   * worker files obvious strong-bulk senders (`migrationBulkPlacement`: `List-Unsubscribe` plus a
   * corroborating list marker) out of the Screener into Reads/Receipts. DETERMINISTIC routing
   * only: no classifier call, no credit debit. Every move is durable and user-reversible, never a
   * delete, and it writes NO `rules` row — the sender still screens next time. A
   * sensitivity-flagged message is NEVER auto-moved, so a stranger's login code stays at the gate
   * for a human. NULL, no row, and a FAILED read all read as OFF — the other default would move
   * mail on a fetch error.
   */
  screenerAutoApplyAt: timestamp("screener_auto_apply_at", { withTimezone: true }),
  /**
   * "Use folders" — when the account turned the optional folders feature on, or NULL for off
   * (FOLDERS-SPEC.md §6). ON means: the mailbox's OWN folders — the passive inventory minus the
   * organized six, Sent and the `ohmail` namespace — are materialized as `folder` entities on
   * /sync. It moves NO mail and issues NO IMAP command: first render on a fifteen-year-old
   * mailbox is a read-only act. The WRITE transition appends the matching `change_log` rows
   * (creates on enable, delete tombstones on disable) so a live mirror follows without a
   * re-bootstrap — see `setFoldersEnabled`. Read as `IS NOT NULL`; NULL, no row, and a failed
   * read all mean OFF — off is the pre-feature interface byte for byte.
   */
  foldersEnabledAt: timestamp("folders_enabled_at", { withTimezone: true }),
  /**
   * When this account FINISHED screening its backlog — the instant the dormancy window is
   * measured back from, instead of from `now()`. With a baseline the cutoff STOPS SLIDING: mail
   * older than the cutoff can never make an undecided sender active, not even unread; a stranger
   * who wrote AFTER the baseline never goes dormant. NULL is exactly the pre-0056 behaviour; the
   * narrowing is gated on the baseline being PRESENT, never a `?? now()` default — the second
   * program empties a live Screener queue on deploy. Read as an INSTANT. Written once, by the
   * first screener decide, only while NULL; never derived from `min(rules.created_at)` — rules
   * are deletable, and a baseline travelling backwards would re-open the queue.
   */
  screeningBaselineAt: timestamp("screening_baseline_at", { withTimezone: true }),
  /**
   * Remote images — the OPT-OUT (mail 0048). NULL (and no row) = the default: remote images load
   * automatically through `GET /img`, which fetches server-side so the sender never learns the
   * reader's address. NOT NULL = this account asked to keep the per-message "Show images" consent
   * flow. Stored as the opt-out so the default moves with the product. The ONE flag on this row
   * whose failed read defaults to the NON-null branch: "off" is what loads remote content, so an
   * unknown answer resolves to MANUAL — a client that could not ask must never load trackers for
   * somebody who opted out. Row-absent is NOT that case: a real answer meaning auto. A tracking
   * pixel is unaffected in either mode.
   */
  blockRemoteImagesAt: timestamp("block_remote_images_at", { withTimezone: true }),
  /**
   * Tracking pixels — the OPT-OUT of a protection; the sign is the opposite of the column above
   * (mail 0072). NULL (and no row) = the default: a beacon, a 1×1 or a zero-dimension image is
   * never fetched, in either images mode. NOT NULL = this account asked for pixels to load. Two
   * opt-out columns whose NULLs mean OPPOSITE postures: {@link blockRemoteImagesAt} NULL is
   * permissive, this NULL is protective — a reader must not assume the two agree. The failed-read
   * direction equals the row-absent direction here, unlike its neighbour: unknown means blocked,
   * because loading a beacon for somebody who never asked is the one outcome this column may not
   * produce. Governs only the sanitizer's pixel override.
   */
  loadTrackingPixelsAt: timestamp("load_tracking_pixels_at", { withTimezone: true }),
  /**
   * Auto-unsubscribe on screen-out — the OPT-OUT (mail 0054). NULL (and no row) = the default:
   * screening a sender out hands the re-routed mail to the RFC 8058 one-click path — one request
   * per list per mailbox, `List-Unsubscribe-Post` only, sent server-side. NOT NULL = this account
   * asked it to stop. Opt-out because the behaviour is ALREADY ON everywhere — an opt-in column
   * would have turned it off for everyone on deploy. The reader is
   * `UnsubscribeService.onScreenOut`, the AUTOMATIC entry point, nothing else: the manual button
   * is a person pressing unsubscribe on mail in front of them. A failed CLIENT read resolves to
   * ON: the client's use is deciding whether to DISCLOSE a request the server will make anyway.
   */
  blockAutoUnsubscribeAt: timestamp("block_auto_unsubscribe_at", { withTimezone: true }),
  /**
   * The interface language — `'en' | 'de'`, or NULL for "nobody has chosen" (mail 0053). The only
   * column here a CLIENT resolves: `GET /consent` sends it and the client adopts it at boot — "my
   * account is in German" has to hold on a machine that has never seen this account. NULL is not
   * `'en'`: a device remembers its own language in `localStorage`, an account preference WINS
   * over the device's, and an account with no preference LEAVES THE DEVICE ALONE. Storing `'en'`
   * for everyone would make every boot on a German-set browser silently reset to English — the
   * default is never stored, and `setLocale` maps a request for the default back to NULL. A
   * FAILED read is not "English": the field stays null, meaning "keep the device's language".
   */
  locale: text("locale"),
  /**
   * The appearance FACE — `'paper' | 'ohmarchy'`, or NULL for "nobody has chosen" (mail 0082);
   * light/dark stays device-local. As {@link locale}, with ONE inversion: the default IS stored.
   * `setThemeFace('paper')` persists `'paper'`, because NULL and "asked for paper" are different
   * states on a Linux device, which defaults to ohmarchy when nobody has chosen anywhere — an
   * explicit account-wide 'paper' overrides that detection, and collapsing it to NULL would make
   * the request unsayable on the one class of device it targets. This column is the "apply for
   * all devices" half; "only this device" never reaches the server — it is the device's
   * `localStorage` pin, which outranks this column there.
   */
  themeFace: text("theme_face"),
  /**
   * When this account finished (or cancelled) the first-run flow. Onboarding state is DERIVED
   * from truth-conditions, never a step counter: the current step is the first UNMET of consent,
   * screening baseline, import complete, AI answered, this. Every other condition has a witness
   * in the schema; this one has none, because "done with the flow" is not a fact about mail.
   * CANCEL AND FINISH BOTH STAMP IT: cancel means "stop asking me", and a cancel that left the
   * column NULL would re-open the flow on every launch forever. Re-running from Settings
   * re-stamps, so the value is the LAST completion. Read as `IS NOT NULL`, like every stamp on
   * this row bar {@link screeningBaselineAt}.
   */
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  /**
   * Screening scope — `'window'` (the default) or `'all_time'` (mail 0083). "All time" is a MODE,
   * not a window value, and there was no way to spell it: `dormancyDays` is bounded 1–365 and
   * NULL means the product default, so no number there says "no cutoff at all". `'all_time'`
   * means NO cutoff and NO dormancy in BOTH readers — `resolveScreeningCutoff` on the server and
   * `consent-cutline.ts` on the client, held in step by a parity test: nothing is filed to
   * History unscreened, and no sender ages out unanswered. NOT NULL with the default stored,
   * unlike {@link dormancyDays}: no device-local default to defer to, so storing 'window' removes
   * a three-valued read.
   */
  screeningScope: text("screening_scope").notNull().default("window"),
  /**
   * NO request-key column here, and the absence is the design (mail 0090). A reader's decision
   * record is signed so an organizer can tell this account's own install from anything else with
   * write access to `ohmail/_meta`. A per-account key stored here and fetched over the hosted API
   * was withdrawn: a LOCAL install talks only to the mail server and has no authenticated call to
   * fetch one on. The key is HKDF-SHA256 over the MAILBOX PASSWORD instead — the one secret both
   * installs already hold and the attacker in question (folder rights via an ACL or sieve rule)
   * does not — computed at use, never stored (`deriveRequestKey`). No rotation column: changing
   * the password changes the key, which is exactly when older records should stop verifying.
   */
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * The mail-domain half as one object, for `drizzle(client, { schema })`.
 *
 * Spread into `schema` by `./schema.js` for every consumer that wants both halves. A local
 * install passes THIS one and nothing else — see `apps/sidecar/src/db.ts`.
 */
export const mailSchema = {
  mailboxes, mailboxCredentials, mailboxFolders, messages, messageInstances, messageFailures, folderState, flagState, rules, contacts, auditLog, accountSyncState, changeLog, threads, messageBodies, routingDecisions, approvals, messageStates, graduations, learningSignals, accounts, users, devices, sessions, refreshTokens, pairingTokens, idempotencyKeys, trackerEvents, contactNotes, threadNotes, snippets, notifyRules, awayResponders, awayResponderSent, attachments, kbEntries, drafts, outboundSends, workflows, workflowRuns, workflowProposals, tags, messageTags, unsubscribeRecords, accountSettings,
};
