/**
 * THE MAIL-DOMAIN SCHEMA — the 43 tables a mailbox needs, and the only half that ships.
 *
 * (The number said 41 while the partition said 42, which is what a count kept in prose does. The
 * authority is the schema-split test, which asserts the count as a literal against the
 * declarations in this file; this line is a summary of that and must follow it.)
 *
 * ── WHY THIS FILE IS SEPARATE FROM ITS CLOUD SIBLING ──────────────────────────────────────
 *
 * The migration journal was split first (`@ohmail/db-mail`'s `drizzle/` and this package's
 * `drizzle-cloud/`), because a Stripe migration is Cloud logic expressed IN SQL and could not
 * stay in a journal that ships. The TypeScript stayed one 1 843-line file for a while longer,
 * and that gap had a cost that no test could see: the local engine imported the whole schema
 * object, so its bundle carried the hosted service's credential-hash and billing-ledger column
 * definitions into an artifact whose sources are published.
 *
 * The partition is the journal's partition. One guard holds the per-table justification and both
 * table counts as literals, and the split here is checked against that guard rather than being a
 * second opinion about the same question.
 *
 * ── THE DIRECTION RULE ────────────────────────────────────────────────────────────────────
 *
 * **This file may not import `./schema-cloud.js`, and the ban is asymmetric on purpose.** The
 * mail half has to stand alone: it is what a desktop install migrates and what a desktop
 * install's database contains. The reverse is legal and unavoidable — every Cloud table with a
 * `references(() => accounts.id)` reaches back into this file, exactly as every
 * `REFERENCES public.accounts` in the cloud journal reaches into the mail one.
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
  // ── Mail 0023 — WHY a mailbox failed, not merely THAT it did ──
  //
  // `status` alone was the whole record, so an operator and the account holder's own Settings pane
  // could both say "something went wrong" and nothing more — which is how a disk-full incident
  // once stayed opaque for hours. The four columns are evidence, never control flow: nothing
  // reads them to make a decision, and every consumer treats NULL as "not recorded".
  //
  // `errorDetail` IS NEVER A RAW ERROR STRING. It is a member of a CLOSED allowlist held by the
  // worker's mailbox-error classifier — an IMAP response code, a Node
  // errno, a TLS constant, an SQLSTATE — checked at the single write site (`markMailboxFailed`),
  // because a throw out of the sync cycle can embed RFC822 header bytes (raw message content) and a
  // login failure's server text can echo the credential. Same contract `packages/core/src/log.ts`
  // already holds every log line to.
  //
  // MEMBERSHIP, NOT SHAPE, and the difference is a finding. This used to be a regex plus "or our
  // own host:port"; imapflow derives `serverResponseCode` from the SERVER's own bracket atom, so
  // a hostile endpoint answering `NO [SECRETPASSWORD123]` chose a value that passed the shape
  // test and reached both the account holder's Settings pane and the admin console. Nothing here has
  // ever written a host:port and nothing may: an unrecognised token stores NULL.
  errorCode: text("error_code"),                                           // a MAILBOX_ERROR_CODES member, or null
  errorDetail: text("error_detail"),                                       // allowlisted token, or null
  failedAt: timestamp("failed_at", { withTimezone: true }),                // when the CURRENT outage began (COALESCE on write)
  retryCount: integer("retry_count").notNull().default(0),                 // attempts within the current outage
  // ── Mail 0039 — WHEN the leader may next try this mailbox, and who else can change it ──
  //
  // The quarantine backoff, made durable. It used to live only in the worker's in-process
  // `Map<string, Quarantine>`, which meant a parked mailbox had exactly two exits: the ladder
  // expiring, or a restart of the sync process. No database write could clear it, so nothing
  // outside that process could release a mailbox — not an operator, not the account's owner —
  // and "restart the sync worker" was the only release mechanism there was.
  //
  // NULL means no backoff is in force: never quarantined, or a completed sync cleared it, or an
  // operator released it. Written by the worker (`markMailboxFailed`), cleared by every writer
  // that makes a backoff untrue (`markMailboxConnected`, `markMailboxStoodDown`,
  // `MailboxService.update` on the way out of `error`) and by the admin release write.
  //
  // IT IS NOT A SECOND `retry_count`, and the difference is the point. `retry_count` above is
  // the SIZE of the current outage and is deliberately allowed to disagree with the worker's
  // in-memory attempt count after a restart; this is the one fact neither carries — WHEN. The
  // ladder's attempt count stays in memory, so a release does not reset it: an operator freeing
  // a mailbox must not hand a struggling provider a fresh minimum-interval retry loop.
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
  // ── Mail 0027 — the organizer lease ──
  //
  // `disabledReason` is WHY this mailbox is `status='disabled'`, when the reason is the lease
  // rather than a person. A CLOSED set of three (`MAILBOX_DISABLED_REASONS`, mailbox-errors.ts)
  // and a CHECK constraint behind it, because it is read by the account's own user and must
  // never be able to hold a string a mail server chose — the same finding that closed
  // `error_detail`, applied before it can happen here. NULL for every non-lease disable, which
  // is what makes "Organized by Cloud" and "Cloud stopped organizing" tellable apart from
  // an ordinary disabled mailbox.
  //
  // It is EVIDENCE plus one decision, and the decision is the user's: nothing re-enables a
  // mailbox except an explicit PATCH, because the lease principle is "ceasing to organize is always
  // automatic; BECOMING an organizer always requires an explicit human action".
  disabledReason: text("disabled_reason"),
  // When a human explicitly asked THIS organizer to take this mailbox over from another one.
  // Consumed on the first successful gate: it authorizes one BECOMING, never a standing right,
  // or a lapse-then-resubscribe would silently seize a mailbox back from a deliberate local
  // choice (the lease's "No seize-back" rule).
  takeoverAuthorizedAt: timestamp("takeover_authorized_at", { withTimezone: true }),
  // ── Mail 0083 — THE ORGANIZING ROLE, WHICH IS NOT THE CONNECTION ──
  //
  // A row carries two independent facts and `status` used to hold both. `status` is whether
  // ohmail can REACH this mailbox; this column is whether ohmail ORGANIZES it. The stand-down
  // encoded the second in the first (`disabled` + `disabledReason`), which was right while the
  // only two states were "ours" and "not ours at all", and is wrong now that the answer to
  // "somebody else organizes this" is BE ANOTHER MAIL CLIENT: read it, search it, mark it read,
  // send from it, and touch nothing else. That install is connected and syncing, so it cannot be
  // `disabled` — `loadEnabledMailboxes` filters those out and a reader needs the roster to have
  // a mirror at all.
  //
  // NOT NULL with the pre-migration behaviour as its default, which is what makes the deploy
  // safe in both directions: an un-updated worker binary organizes exactly what it organized
  // yesterday, and a new binary against a row nobody has touched reads 'organizer'.
  //
  // 'reader' IS THE PRE-CONSENT STATE AS WELL AS THE LOST-THE-LEASE ONE, and that is the design
  // rather than an overload. `POST /mailboxes` creates a consent-less reader, so a fresh connect
  // builds its mirror at once, creates no `ohmail/*` and moves nothing — there is no
  // half-applied mailbox because the reader mode IS the pre-consent state. What separates the
  // two is {@link organizeConsentedAt}, not this column.
  //
  // The set is closed by `mailboxes_organizer_role_closed`; members are `ORGANIZER_ROLES`
  // (organizer-role.ts) and a real-Postgres test reconciles the two.
  organizerRole: text("organizer_role").notNull().default("organizer"),
  // WHO holds the lease when we do not — the three columns a banner needs, written from
  // `StandDownVerdict.by` at the stand-down and refreshed each reader cycle.
  //
  // `organizedByKind` is the same closed three as `disabledReason`'s suffix ('cloud' | 'local' |
  // 'unknown'), behind `mailboxes_organized_by_kind_closed`, for `disabledReason`'s own reason:
  // it is read by the account's own user and must never be able to hold a string a mail server
  // chose.
  //
  // `organizedByName` is the holder's `X-Ohmail-Display-Name` — A CUSTOMER'S MACHINE NAME. It is
  // header-safe and capped at `ORGANIZED_BY_NAME_MAX` at the single write site, and it is on the
  // admin DTO deny-list: staff see the role and the kind, never the name. No CHECK, because free
  // text closes no set — the bound is at the write site, exactly as `signature`'s is.
  //
  // `organizedSince` is the holder's `X-Ohmail-Claimed-At`: when they BECAME the organizer, as
  // distinct from when they were last seen. The heartbeat is deliberately not persisted — see
  // {@link organizerState}.
  organizedByKind: text("organized_by_kind"),
  organizedByName: text("organized_by_name"),
  organizedSince: timestamp("organized_since", { withTimezone: true }),
  /**
   * The lease's `LeaseOccupancyState` — `'held'` (somebody is renewing) or `'stopped'` (somebody
   * WAS organizing and nothing has renewed since). NULL is "we have not looked".
   *
   * **`apps/worker/src/lease.ts` argued this value must NEVER be persisted, and the premise it
   * argued from has moved.** Its reason was that a stood-down mailbox left the roster, so nothing
   * would ever refresh the column and it would keep saying "somebody is organizing this" long
   * after they stopped. A READER stays connected and cycles, so there is a later writer: every
   * reader cycle refreshes this from a `peekLease` read — the APPEND-less IO, so looking costs no
   * claim. The value is therefore never older than one poll interval. The mailbox with no writer
   * for it is a tombstone, which nothing displays.
   *
   * Closed by `mailboxes_organizer_state_closed`.
   */
  organizerState: text("organizer_state"),
  /**
   * WHEN A HUMAN ASKED THIS INSTALL TO ORGANIZE THIS MAILBOX — the consent event, per mailbox.
   *
   * NULL means nobody has. That is the state `POST /mailboxes` now creates and the state a fresh
   * standalone launch is in: the mirror builds, and not one message moves. It is written by
   * `MailboxService.organizeHere` (the one ceremony, every door) in the same transaction as
   * `takeoverAuthorizedAt` and the account's screening window — and, crucially, in the same
   * transaction as `accountSettings.screeningBaselineAt` while that is still NULL, because
   * without a baseline there is no cutoff and the ENTIRE backlog goes to the Screener whatever
   * window the person chose.
   *
   * `COALESCE(., now())` on write: consent is the FIRST time, and re-running onboarding must not
   * move the record of when the person agreed.
   *
   * Backfilled by mail 0083 to `created_at` for every connected row, because connecting a
   * mailbox WAS the consent under the old copy — a record of something that happened, which is
   * the line 0027 drew when it refused to invent a `takeover_authorized_at`.
   */
  organizeConsentedAt: timestamp("organize_consented_at", { withTimezone: true }),
  // ── Mail 0065 — the provider's OWN Junk and Trash folders, as discovered at connect ──
  //
  // Canonical (`/`-delimited) paths, resolved by the worker's connect-time discovery
  // (`ImapAdapter.findSpecialFolders`: SPECIAL-USE first, then the name belts) and re-written on
  // every connect, so a mailbox that gains or renames the folder heals on its next attach. NULL
  // means the mailbox genuinely has neither the flag nor a recognisable name — never "not yet
  // asked" for a mailbox the worker has attached since this column landed.
  //
  // They exist because the API may never open IMAP: a delete must be refused UP FRONT when the
  // mailbox has no Trash (`no_trash_folder`), and the reconciler must know where a spam verdict
  // physically files without a LIST per pending row. EVIDENCE for those two decisions only;
  // nothing else reads them, and the folders they name are never watched (imap-types.ts carries
  // the product rule and its 2026-08-22 amendment).
  junkFolder: text("junk_folder"),
  trashFolder: text("trash_folder"),
  // ── Mail 0073 — per-mailbox "Use folders", stored as the EXCEPTION (FOLDERS-SPEC.md §17;
  // owner ruling 2026-08-25) ──
  //
  // The account's `account_settings.folders_enabled_at` stays the master switch; under it every
  // mailbox participates BY DEFAULT, so NULL — and a failed read — mean "this mailbox's folders
  // show", and a timestamp is "when this mailbox was switched OFF" (the support question). The
  // sign is deliberately the master's opposite: the FEATURE defaults closed, but within an
  // opted-in account the per-mailbox default is open, because all-mailboxes-showing is what the
  // account just asked for. Read through the mailbox join `listUserFolders` already makes
  // (`packages/services/src/folders.ts`); written only by `setMailboxFoldersEnabled`
  // (consent-seed.ts), whose transaction also writes the folder create/delete change rows so a
  // live rail follows the switch. The worker neither reads nor writes it — `mailbox_folders`
  // keeps its cursors either way (the passive read is not consent-gated; SHOWING is).
  foldersDisabledAt: timestamp("folders_disabled_at", { withTimezone: true }),
  // ── Mail 0075 — the per-mailbox SIGNATURE (owner ruling 2026-08-27) ──
  //
  // The text a compose offers under the message when this mailbox is the sender. NULL is "no
  // signature" — the default, costing nothing anywhere. STORED TEXT ONLY: whether an outgoing
  // message carries it is the compose surface's decision (the signature is a visible, removable
  // block there and serializes into the body at send exactly as shown), so the send path never
  // reads this column. Written by `setMailboxSignature` (consent-seed.ts), whose transaction
  // moves the account-settings stamp and appends the `settings` change row — the same wake the
  // per-mailbox folders dial rides — so open composers everywhere re-read `GET /consent` and
  // swap to the new text live. Length is bounded at the write site
  // (`MAILBOX_SIGNATURE_MAX_CHARS`, a 400), not by a CHECK: free text closes no set, and a
  // byte bound in the database would answer 23514 to a person typing.
  signature: text("signature"),
  // ── Mail 0076 — THE ONE-TIME QUARANTINE→\Junk SWEEP, RECORDED AS A COMMAND (FOLDERS-SPEC.md
  // §16.1: "an optional ONE-TIME sweep offers to move the old ohmail/Quarantine pile into
  // native Junk … One press, one direction, then the offer is gone") ──
  //
  // A DOORBELL WITH A NAME, on `sync_requested_at`'s exact shape: the API stamps it when the
  // account's user presses the offer (`POST /screener/junk/sweep`), the worker consumes it at
  // the top of the mailbox's serial cycle — runs `junkSweepPass` under the organizer lease, then
  // clears ONLY the value it observed — and NULL is "no sweep owed", the state of every row. The
  // §16.1 carve-out is why it is a stamp the WORKER serves rather than a move the API performs:
  // the sweep is user-commanded, but it is the one junk write that is a bulk organization act
  // over mirrored rows (`folder_state`, husks, locators), and those the API never applies
  // itself — it records the command and the always-on organizer executes it, like every move.
  // Nothing reads it to route mail; the offer's visibility is the CANDIDATE COUNT (mail still
  // physically in `ohmail/Quarantine`), so "never offered twice" needs no second column — a
  // swept pile has no candidates, and a pile that grows again (a flag-off verdict) is offered
  // again honestly.
  junkSweepRequestedAt: timestamp("junk_sweep_requested_at", { withTimezone: true }),
  // ── Mail 0078 — THE FORWARDING-DETECTION NOTICE's two columns ──
  //
  // Born from a real incident: a mailbox synced perfectly for weeks while a provider-level
  // forward (no "keep a copy") diverted every inbound mail before IMAP storage — the product
  // was healthy and said nothing, and two days of debugging pointed at ohmail when the answer
  // was upstream. These columns are how the product notices that shape and says it.
  //
  // `inboundQuietSince` is EVIDENCE, and the worker's inbound-quiet pass
  // (`apps/worker/src/inbound-quiet.ts`) is its single owner: when a connected,
  // healthily-syncing, fully-imported mailbox's GENUINE inbound (From ≠ the mailbox's own
  // address; ohmail's own moves create no message rows and so never count) has been zero for
  // the pass's generous window while evidence says mail should be arriving — a sibling mailbox
  // receiving normally, or the newest genuine inbound being months old — the pass stamps the
  // newest genuine inbound `date` the mailbox holds (`created_at` when it never held one).
  // NULL is "no quiet episode". COALESCED for the episode's life (`failed_at`'s discipline) and
  // cleared only when genuine inbound RESUMES — several arrivals inside the window, so one
  // stray mail can neither end an episode nor re-arm the notice against a standing dismissal.
  //
  // `inboundQuietDismissedAt` is the USER's per-mailbox dismissal
  // (`POST /mailboxes/:id/inbound-quiet/dismiss`). The server never reads it and the worker
  // NEVER clears it; the client shows the notice only while `dismissedAt < since`. That pair of
  // instants is the renotify discipline in two columns: an undisturbed episode never re-notifies
  // (sameness holds), and a NEW episode's `since` — a newer inbound date, which can only exist
  // because mail actually flowed after the dismissal — re-notifies (a state change).
  inboundQuietSince: timestamp("inbound_quiet_since", { withTimezone: true }),
  inboundQuietDismissedAt: timestamp("inbound_quiet_dismissed_at", { withTimezone: true }),
  // ── Mail 0029 — WHY A `connected` MAILBOX IS NOT BEING SYNCED ──
  //
  // The other half of that outage. The adoption bug (a `FETCH 1:*` against an empty
  // `ohmail/_meta`, which Dovecot refuses and GreenMail tolerates) has since been fixed; this is
  // the stretch of time a user spent looking at a spinner while the worker knew exactly what was
  // wrong and wrote it ONLY TO A LOG. Three branches declined to serve a mailbox they knew was
  // expected and left the row pristine: `LeaseUnavailableError`, `awaitingCreds` (which announced
  // itself once EVER), and the `maxMailboxes` cap.
  //
  // A CLOSED set of three (`MAILBOX_SYNC_BLOCK_REASONS`, mailbox-errors.ts) with a CHECK behind
  // it, and closed for a reason `error_code`'s "taxonomies grow" does not touch: these are the
  // ways OUR OWN infrastructure declines, so the set is enumerable by reading the worker and no
  // member can ever be chosen by a mail server. There is deliberately no `no_organizer` member —
  // read the header of the constant before adding one.
  //
  // ── IT IS ORTHOGONAL TO `status`, AND THAT IS THE WHOLE POINT ──
  //
  // `status` stays `connected`. Three designs were killed on evidence before this one: an
  // `error_code` value is INVISIBLE on the wire (`MailboxService.toDTO` and `admin-service`'s
  // `lastError` both gate on `status === 'error'`); a fourth `status` value breaks the webapp at
  // runtime (a missing i18n key, a 3-member DTO union, `mailboxes_active_address_uq`'s partial
  // predicate); and deriving it from the hosted sync fleet's liveness table cannot answer a
  // PER-MAILBOX question, because that table holds one row per SHARD.
  //
  // NOT a failure and NOT a disable: no `error_code`, no `failed_at`, no retry backoff — an
  // infrastructure fault must never quarantine a mailbox. Every writer that makes the statement
  // untrue clears BOTH columns in the same statement (`markMailboxConnected`,
  // `markMailboxStoodDown`, `markMailboxFailed`, `MailboxService.update`).
  syncBlockedReason: text("sync_blocked_reason"),
  // When the CURRENT block began — `coalesce(sync_blocked_since, now)` on write, exactly as
  // `failed_at` does, so a mailbox blocked for three days reports three days instead of "just
  // now, again" on every roster pass.
  syncBlockedSince: timestamp("sync_blocked_since", { withTimezone: true }),
  // ── Mail 0049 — ENFORCED SYNC: "the mailbox owes a reconcile RIGHT NOW", set by the API ──
  //
  // The worker's ordinary rhythm is a poll every `pollIntervalMs` (60 s) plus an IDLE push from
  // the server. That is fine for mail arriving, and too slow for a change the USER just made and is
  // watching for: a send whose Sent copy has to appear, a folder move whose desired-state write the
  // mirror should reflect. Waiting up to a minute for the worker's next cycle is the gap between
  // "I did that" and "I can see I did that".
  //
  // So the API STAMPS this column the instant it finalizes such a write — `now()` — and a short
  // worker scan (`sync-kick.ts`, ~3 s) picks up any stamped mailbox IT SERVES and triggers an
  // out-of-band cycle, then clears the stamp. NULL is the resting state: nothing owed. A timestamp
  // means "a user-visible write landed at this instant; reconcile and clear".
  //
  // ── IT IS A REQUEST, NOT A SCHEDULE, AND THE CLEAR IS COMPARE-AND-CLEAR ──────────────────────
  //
  // The kick clears ONLY the exact value it observed (`WHERE sync_requested_at = <observed>`), so a
  // second stamp that lands WHILE the kick is running is not lost — the clear misses, and the next
  // scan re-kicks. That is the whole of its convergence: a stamp is either being served or will be
  // on the next pass, and a burst of stamps collapses to at most one extra cycle. Nothing reads it
  // to make a routing decision; it is a doorbell, not state.
  //
  // Additive, nullable, no default, no CHECK — a timestamp closes no set (0030's rule). Only the
  // API writes it and only the worker clears it; a deploy in either order is safe, because an
  // unstamped mailbox is exactly today's poll-only behaviour.
  syncRequestedAt: timestamp("sync_requested_at", { withTimezone: true }),
  // ── Mail 0055 — WHAT THE SENDING SERVER SAID IT WILL ACCEPT (RFC 1870 `SIZE`) ──
  //
  // The attachment ceiling used to be one product constant, and it was reasoned from the HOSTED
  // API's serverless request-body limit — attachment bytes ride the send request as base64, so
  // 3 MB of raw bytes encodes to about 4 MB and clears a ~4.5 MB body cap. That is a true fact
  // about one deployment and no fact at all about a LOCAL install, which runs the same
  // `SendService` in its own process and hands the message straight to SMTP with no request body
  // anywhere in the path. It was refusing attachments the user's own mail server would have taken.
  //
  // This is the number that actually governs: the ceiling the submission server announces in its
  // EHLO reply. It is written by the connect-time SMTP probe, which already runs a full EHLO
  // before it stores a credential, and read on the send path and in the mailbox DTO.
  //
  // NULL IS "NOT KNOWN", AND IT IS READ AS THE STRICT ANSWER. Three servers write NULL and are
  // deliberately not told apart — one that never advertised `SIZE`, one that advertised the bare
  // keyword, and one that advertised `SIZE 0` (RFC 1870 §6: "no fixed maximum"). All three answer
  // *"is there a ceiling I must stay under?"* with "none that I stated". `SendService` resolves an
  // unknown ceiling to the product's own 3 MB rather than to "unbounded": an unknown limit read as
  // no limit is a message the user composes, waits for, and has bounced by their own provider.
  //
  // `bigint` and not `integer` because the value is an unbounded decimal in somebody else's reply
  // and an eccentric announcement above 2^31 must be storable rather than raise 22003 inside the
  // connect flow's transaction. No CHECK (a size closes no set) and no index — it is read off a row
  // already fetched by primary key and is never a predicate.
  smtpMaxSizeBytes: bigint("smtp_max_size_bytes", { mode: "number" }),
  // ── Mail 0063 — WHEN THE `SIZE` BACK-FILL LAST ASKED, AND WHAT IT HEARD ──
  //
  // The pair that turns the back-fill's selection from "every row that still announces nothing"
  // into a backoff. The column above stays NULL for three outcomes that are not failures of the
  // pass — a server that advertises no `SIZE`, a login it refuses, a mailbox with nothing to dial
  // — so a selection keyed on `IS NULL` alone re-picked exactly those rows on every scheduled run,
  // for ever: a permanently silent submission server cost a real login a day, and once a batch's
  // worth of them existed no learnable mailbox was ever reached again.
  //
  // NOT A TERMINAL STATE, and the asymmetry with `smtp_max_size_bytes` is deliberate: nothing here
  // ever says "never ask again". `smtp_size_probed_at` is WHEN we last asked and
  // `smtp_size_probe_code` is what came back, and the pass re-asks on an interval chosen from the
  // code (a month for a server that answered and named nothing, a week for anything else). A
  // provider that raises its limit is picked up on the next interval, and a person who re-enters
  // their password gets the real number immediately, because that path writes the column directly.
  //
  // ONLY THE API HOST WRITES THESE. The sync host's arm of the same back-fill deliberately does
  // not: on the managed deployment its platform blocks outbound submission, so a stamp from there
  // would record "unreachable" for every mailbox and suppress the one host whose egress works.
  //
  // `smtp_size_probe_code` carries a CHECK (`SMTP_SIZE_PROBE_CODES` in `mailbox-errors.ts`) because
  // the value is derived from an SMTP AUTH failure, and a submission server's own response line —
  // which can carry the username, an echoed credential, or arbitrary provider text — must not be
  // able to reach a column through a write site nobody has reviewed yet. Same reasoning as
  // `sync_blocked_reason`'s constraint, with a sharper origin.
  smtpSizeProbedAt: timestamp("smtp_size_probed_at", { withTimezone: true }),
  smtpSizeProbeCode: text("smtp_size_probe_code"),
  // ── Mail 0030 — the ONE-TIME re-evaluation of mail the sensitivity override already misrouted ──
  //
  // A fix stopped `pipeline.ts:393` letting a sender-chosen subject or body carry a stranger
  // past the consent gate. It is forward-looking only, and the damage was already filed:
  // when it was measured, a large majority of the Ohbox's rows were sensitive and nearly all of
  // those came from a sender absent from `contacts`. This column is the whole of that correction's
  // idempotency — NULL means "never re-screened", a timestamp means "done, never again".
  //
  // A MARKER, exactly as `kickstart_at` is, and stamped by the same rule for a sharper reason:
  // AFTER the pass, never before it. Claiming it first would make a crash permanent — a mailbox
  // marked corrected with half its misrouted mail still in the Ohbox and nothing that would ever
  // look again. Re-running is safe without the marker at all, because the pass's candidate query
  // is what makes it idempotent: a message it has moved is desired into `ohmail/Screener` and is
  // no longer a candidate. The marker saves the scan, not the correctness.
  //
  // It is NOT `kickstart_at` re-used, and that was considered first: `listScreenerBacklog`
  // selects the INVERSE candidate set (desired = `ohmail/Screener`) and the kickstart marker is
  // already stamped on every live mailbox. Written by the one-time re-screen pass and by nothing
  // else.
  sensitiveRescreenAt: timestamp("sensitive_rescreen_at", { withTimezone: true }),
  /**
   * WHERE THE RE-SCREEN GOT TO — the last `messages.id` of the last COMMITTED page (mail 0081).
   *
   * The marker above says whether the pass is FINISHED. This says where it is. They are
   * different facts and the pass needs both, because it is bounded:
   * `SENSITIVE_RESCREEN_MAX_PAGES` stops it after 50 000 rows and it then correctly declines to
   * stamp the marker. Without a resume point the next run started at the beginning again, and
   * whether that made any progress depended on the rows already seen dropping out of the
   * candidate query. The MOVERS drop out — a message sent to the Screener is no longer desired
   * into the Ohbox. The STAYERS do not: a candidate the re-evaluation deliberately leaves in
   * place (a known sender's login code) satisfies the candidate query for ever. So a mailbox
   * whose first 50 000 candidates are stayers re-read the same prefix on every run and never
   * reached the misrouted mail behind it, while reporting progress-shaped counts.
   *
   * The same column, for the same reason, as `rules.retro_cursor` (mail 0034) and
   * `account_settings.ohbox_tidy_cursor` (mail 0043) — this pass was the one member of that
   * family without one. Per MAILBOX, matching the marker beside it: one run is one mailbox.
   *
   * WRITTEN INSIDE THE PAGE'S OWN TRANSACTION, so the position and the work it covers commit
   * together and a kill between them is not a state the database can hold. Advanced under
   * `WHERE cursor IS NULL OR cursor < <new>` so two operators running the pass at once cannot
   * rewind one another; NULLed in the same UPDATE that stamps the marker, so a completed
   * mailbox has no stale resume point and a `force` re-run starts at the beginning — which is
   * what makes the `force` test's "zero writes" mean the candidate query is idempotent rather
   * than that the cursor was already at the end. A dry-run plan READS it as a start and never
   * advances it: every page it writes is rolled back, this UPDATE included.
   *
   * KNOWN LIMIT, stated here rather than rediscovered as a bug — the same one `retro_cursor`
   * records: a row BEHIND the cursor that becomes a candidate again mid-pass is not reconsidered
   * by the remainder of that pass. The pass detects the arm it CAN see before it stamps — a
   * candidate whose `folder_state` was rewritten under the walk, which is how the worker's
   * completion restores a stale Ohbox intent — and declines the marker, clearing this column so
   * the next run re-walks the prefix. It cannot see an exclusion being REMOVED (the user deletes
   * their own rule, or returns a triage state to `none`), because that touches no
   * `folder_state` row. For that arm the supported remedy is to NULL **all three** of this
   * column, `sensitive_rescreen_started_at` and `sensitive_rescreen_at`: clearing this one alone
   * does nothing once the marker is stamped, because the marker is what stops the pass looking at
   * the mailbox at all — and leaving the epoch behind would date the next walk from the previous
   * one, so its completion check would look back over a window that is not its own.
   */
  sensitiveRescreenCursor: uuid("sensitive_rescreen_cursor"),
  /**
   * WHEN THE WALK THAT CURSOR BELONGS TO BEGAN — the window the completion check looks back over
   * (mail 0081). NULL exactly when the cursor is NULL.
   *
   * The check needs the WALK's start and not the RUN's, and the difference is the whole reason
   * this is a column rather than a local. The cursor outlives an invocation: run A stores a
   * prefix and exits, the worker restores one of A's rows to the Ohbox, run B resumes past it.
   * Against B's own start instant that restoration is in the past and invisible, and B stamps.
   * Against the WALK's start it is inside the window, B declines the marker, clears both columns,
   * and the next run re-walks the prefix.
   *
   * Written with `coalesce(existing, <run start>)` in the same guarded UPDATE that stores the
   * cursor, so the first page of a walk sets it and every resumption keeps it. Cleared with the
   * cursor when the marker lands.
   */
  sensitiveRescreenStartedAt: timestamp("sensitive_rescreen_started_at", { withTimezone: true }),
  // ── Mail 0036 — the ONE-TIME repair of bodies a classifier FALSE POSITIVE stored redacted ──
  //
  // A click tracker's percent-escaped slash (`-2F`) put word boundaries around the characters
  // `2Fa`, which the sensitivity vocabulary read as the acronym `2fa`. Mail judged sensitive is
  // stored with its text redacted and NO HTML AT ALL, so ordinary newsletters, invoices and
  // monitoring alerts were filed unreadable — a small fraction of the sensitivity-categorised
  // bodies clear under the fixed classifier. The fix (`packages/core/src/sensitive.ts`,
  // `proseOnly`) is forward-looking; nothing in the product re-reads a stored body, and the only
  // remaining copy of the discarded HTML is the message on the IMAP server.
  //
  // A MARKER, exactly as `kickstart_at` and `sensitive_rescreen_at` are, and it exists for the
  // reason `thread-backfill` needed none: THIS candidate set does not shrink. A message that is
  // still sensitive under the fixed classifier is still categorised, still without html, and
  // therefore still a candidate for ever — so without a marker the pass would re-read every
  // categorised message off the mail server every worker cycle, permanently, to reach the same
  // answer each time.
  //
  // Stamped AFTER the pass, never before: claiming it first makes a crash permanent. Re-running
  // is safe without it, because a message the pass has cleared no longer carries a category and
  // drops out of the candidate query — the marker saves the IMAP reads, not the correctness.
  // Setting it back to NULL is the supported, and only, way to ask for the repair again.
  //
  // Written by the worker's false-positive backfill pass and by nothing else.
  sensitiveFpBackfillAt: timestamp("sensitive_fp_backfill_at", { withTimezone: true }),
  // ── Mail 0038 — WHEN THIS MAILBOX'S FIRST IMPORT ACTUALLY FINISHED ──
  //
  // A first import drains newest-first in bounded batches over minutes, so the server holds a
  // PARTIAL mailbox — a recent block, a gap, then older mail — for the whole of it. The client
  // watches its own mirror grow and says "still syncing"; what it could not see is the import
  // ENDING for a reason other than completion, so a tab that caught up to the partial state
  // called the mailbox done and showed a Screener with a hole in it as the whole of it.
  //
  // NOT `last_sync_at`, and the difference is the point: that column is SHARED (one
  // `UPDATE … WHERE id IN (…)` per cycle, so two mailboxes report an identical age) and lands
  // EARLY (stamped after every successful cycle, backlog or not). This one is PER-MAILBOX and is
  // written ONLY once a cycle completes with `hasBacklog === false` — the first time the import
  // has genuinely drained. The client reads it as a FLOOR: `IS NULL ⇒ still importing`, whatever
  // the mirror is doing.
  //
  // NULL means "the first import is not known to have finished". Written AFTER the drain, guarded
  // on `IS NULL` so it is a once-per-mailbox event, by the worker's sync cycle
  // (`stampInitialImportComplete`) and by nothing else. Clearing it back to NULL is the supported
  // way to make the client speak "still importing" again.
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
    sql`${t.disabledReason} is null or ${t.disabledReason} in ('organized_elsewhere:cloud', 'organized_elsewhere:local', 'organized_elsewhere:unknown')`,
  ),
  // THE SECOND CLOSED SET, AT REST (mail 0029). Members are `MAILBOX_SYNC_BLOCK_REASONS`, and a
  // Postgres test reconciles the two the way the set above is reconciled: insert every member plus
  // one foreign string, and watch the CHECK refuse the last. Declared here to keep the TS schema
  // honest; the constraint is created by the migration.
  ckSyncBlockedReason: check(
    "mailboxes_sync_blocked_reason_closed",
    sql`${t.syncBlockedReason} is null or ${t.syncBlockedReason} in ('lease_unreadable', 'awaiting_credentials', 'at_capacity')`,
  ),
  // THE THIRD AND FOURTH CLOSED SETS (mail 0083). `organizerRole` has no `is null` arm because
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
    sql`${t.organizedByKind} is null or ${t.organizedByKind} in ('cloud', 'local', 'unknown')`,
  ),
  // THE FIFTH (mail 0083). `organizerState` is the lease's occupancy as a reader cycle last saw
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
   * THE FOLDER'S `EXISTS`, AS THE SELECT REPORTED IT (mail 0083) — the first pull's denominator.
   *
   * No truthful total existed anywhere. This table held cursors only, and the adapter read
   * `mb.exists` off every SELECT and discarded it — so the import progress strip had a numerator
   * (the mirror's row count) and nothing to divide it by, and the one number ever shown was a
   * literal multiplier somebody guessed. Remaining is Σ this column over WATCHED folders minus
   * the mirror count; the rate is the client's own rolling `MirrorGrowth`; the ETA is
   * remaining/rate, said as "about", and it is gone at `initialImportCompletedAt`.
   *
   * Written by every cycle that opens the folder, and NULL means "not yet opened under this
   * build" — never zero. A reader writes it exactly like an organizer: counting is a read.
   */
  serverExists: integer("server_exists"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uq: unique().on(t.mailboxId, t.folder) }));

/**
 * USER-COMMANDED FOLDER OPERATIONS — mail 0074 (FOLDERS-SPEC.md stage 2: create / rename /
 * delete from the rail).
 *
 * The folder verbs are REAL IMAP writes in the user's own mailbox, and the API never opens an
 * IMAP connection to organize — so it records the COMMAND here and rings the `sync_requested_at`
 * doorbell, and the worker executes it inside the mailbox's serial cycle (one organizer, one
 * connection discipline), then applies the database consequences and DELETES the row. This is
 * `folder_state`'s desired/observed split lifted one level: the desired state of the folder
 * TREE, one pending row per subject folder.
 *
 *  · `op` is a CHECK-closed set: 'create' | 'rename' | 'delete'.
 *  · `to_folder` is the rename's target canonical path; NULL for the other two (CHECK-paired).
 *  · `status` 'pending' → the worker owes it; 'failed' + `error` → the honest refusal, carried
 *    to every client on the `folder` entity (`FolderDTO.op.error`) until dismissed or replaced.
 *  · UNIQUE(folder_id): ONE command in flight per folder — a second is refused 409 with the
 *    honest sentence, because two pending commands on one subject have no defined order.
 *  · `folder_id` CASCADEs with its inventory row: an op cannot outlive its subject.
 *
 * A row is deleted on completion — done needs no residue; `change_log` carries the history.
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
   * WHEN THIS MESSAGE STOPPED BEING UNREAD — the order "Earlier" is sorted by (mail 0047).
   *
   * Written by the same statement that flips {@link unread}: an instant when the flag goes false,
   * NULL when it goes back to true. It is a record OF that flag and never the source of it, so
   * dropping the column costs the reading order and nothing else.
   *
   * **NULL means "not known", and it must sort BELOW every stamped row rather than being folded in
   * by date.** Two different rows carry NULL — one read before this column existed, and one never
   * read at all — and neither has an honest answer. There is no backfill for the same reason:
   * substituting `updated_at` or `date` would hand the reader a manufactured order they cannot
   * tell from a real one.
   *
   * Nothing filters or pages on it, so it has no index; the sort happens on the client over the
   * window it already holds, and the server's keyset stays `(date, id)`.
   */
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  /**
   * ── Mail 0065 — WHEN THIS MESSAGE LEFT THE MIRROR'S LIVING VIEWS ──
   *
   * Two writers, one meaning: the user DELETED it (`MessageService.delete` — the message rides to
   * the provider's `\Trash` and the mirror stops presenting it), or the worker observed it
   * EXPUNGED from every folder we watch (`tombstoneInstanceless` — the server no longer holds it,
   * and a mirror that kept showing it would be describing a mailbox that does not exist). Both
   * emit a `change_log` `delete`, so every client tombstones the row.
   *
   * A TIMESTAMP AND NOT A ROW DELETE, deliberately: the row is the message's identity —
   * `dedup_key` is what recognises the same message if it re-appears (a restore from Trash in the
   * user's own client), and `change_log`/`message_instances`/threads all reference it. The
   * re-appearance path (`commitChange`'s adopt) CLEARS this and re-emits the entity, which is the
   * "a LATER create resurrects" rule the client apply contract already carries.
   *
   * Every living-view read excludes `deleted_at IS NOT NULL`: the snapshot bootstrap, search, and
   * the folder views (those exclude it structurally — a deleted row's `folder_state` names the
   * Trash path, which no view filters on). GET-by-id deliberately still answers, for idempotent
   * replay and honest inspection.
   */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  snippet: text("snippet").notNull().default(""),          // sensitivity-redacted preview (never an OTP)
  toAddresses: jsonb("to_addresses").notNull().default(sql`'[]'::jsonb`),   // EmailAddress[]
  ccAddresses: jsonb("cc_addresses").notNull().default(sql`'[]'::jsonb`),   // EmailAddress[]
  hasAttachments: boolean("has_attachments").notNull().default(false),
  attachmentCount: integer("attachment_count").notNull().default(0),
  sensitivityCategory: text("sensitivity_category"),      // SensitivityResult.category surfaced in the DTO
  /**
   * The offline DKIM verdict for the CLAIMED author — column added by mail 0028, wired later.
   *
   * The column lands in the mail 0028 migration and **nothing writes or reads it yet.** That is
   * deliberate: wiring it later then needs no DDL, no second journal
   * entry, and no second deploy-ordering exercise for a feature whose risky half is the code.
   *
   * When it is wired, the union is
   * `aligned | signed_unaligned | unsigned | fail | temperror | unavailable`, computed from
   * `change.raw` plus a DNS TXT lookup of the selector — never from a header anyone wrote.
   *
   * **NULL resolves to the PERMISSIVE value, and that is a rule about consent, not a convenience.**
   * Every row that predates the wiring was already decided under the old rules; making a missing
   * verdict fail closed would put previously-accepted senders back in the Screener, which is the
   * single outcome the acceptance criteria roll a deploy back for.
   *
   * No CHECK, on 0023's rule: the vocabulary belongs to the code that computes it, and a new
   * member must be a code deploy rather than a migration that has to land first.
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
  // ── Mail 0034 — WHO SENT IT, which nothing could look up ──
  //
  // There was no index on `from_address` at all. Every existing reader of it — the retro pass,
  // `sensitive-rescreen`'s candidate query, `heldRowsForDomain` — is therefore a sequential scan
  // over the account's messages, and the retro pass runs one PER PAGE, per cycle, per owed rule.
  //
  // `lower(from_address)` and not the raw column: every writer and every reader of an address in
  // this tree case-folds (`mime.ts#toAddr` at parse, `core/rules.ts#matches`, `drizzle-repo`'s
  // `knownSenders`), so an index on the raw column would be unusable by all of them. `id` is the
  // third column so the pass's `ORDER BY messages.id` keyset page is served by the same index
  // rather than a sort. `account_id` LEADS for the reason `messages_account_message_id_header_idx`
  // gives one line up: a sender address is attacker-choosable, so the account is the first key
  // and never a filter applied to a cross-account result.
  //
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
 * PHYSICAL IDENTITY — every locator one LOGICAL message occupies (mail 0028).
 *
 * ── WHY A TABLE, WHEN `messages.native_locator` ALREADY EXISTS ────────────────────────────────
 *
 * One string used to answer three different questions: is this the same logical message, WHICH
 * BYTES ON THE SERVER is it, and did the user move it. `dedup_key` was the first,
 * `native_locator` was the second, and the third was inferred from the second — which is where the
 * consent boundary broke.
 *
 * A logical message legitimately occupies several locators at once: the Sent twin of a self-CC, a
 * mailing-list echo of your own post, a copy the user's own client made, and — the case this table
 * exists for — a SECOND DELIVERY of the same bytes by someone who wants ohmail to treat their mail
 * as mail you already accepted. `native_locator` can name exactly one, so every other one was
 * invisible: absent from `listKnownLocators`, therefore an unknown UID, therefore fetched, parsed,
 * declined and forgotten on every single sync cycle. For ever.
 *
 * ── THE THREE CONSTRAINTS ARE THE MODEL ───────────────────────────────────────────────────────
 *
 *   UNIQUE (mailbox_id, folder, uidvalidity, uid)   one UID inside one server epoch is ONE place.
 *                                                   `uidvalidity` is in the key because a UID
 *                                                   number means nothing outside its epoch — a
 *                                                   folder that resets commonly re-allocates from
 *                                                   low numbers, and treating a reused number as
 *                                                   already-known silences real mail permanently.
 *   UNIQUE (message_id) WHERE is_primary            exactly ONE instance per message is the one
 *                                                   `messages.native_locator` mirrors and the one
 *                                                   `adapter.move` acts on. A partial unique index,
 *                                                   which is the kind of object an in-memory
 *                                                   Postgres can mislead you about, so it is
 *                                                   covered against a real server.
 *   INDEX (message_id)                              every read here is by message.
 *
 * ── AND WHAT A ROW'S EXISTENCE MEANS ──────────────────────────────────────────────────────────
 *
 * "This locator is on the server." There is no `absent` column, because absence is the row being
 * gone — written only by the worker consuming the adapter's `deletes`, and only when the folder's
 * epoch matches. That deletion is the ONLY evidence in the system that authorises adopting a
 * placement we did not choose: a sender can make a locator appear; only the user can make a stored
 * locator disappear.
 *
 * `messages.native_locator` STAYS as the primary's mirror and every existing read path keeps using
 * it: this change deliberately does not touch a read path. The only read that moved is
 * `listKnownLocators`, because that is the one that decides what gets re-fetched.
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
 * ONE MESSAGE THE SYNC LOOP COULD NOT INGEST — durable, content-free, and retried by UID.
 *
 * The in-memory ledger (`apps/worker/src/dead-letter.ts`) records that a message could not be
 * processed and MOVES PAST IT, which is what stops one malformed message wedging a whole mailbox.
 * For the folders the loop enumerates end to end that record can afford to be process-local: the
 * known-set diff re-offers the UID after a restart. The SENT folder's cursor is a UID WATERMARK,
 * so a skipped UID the watermark has crossed is never enumerated again — and `own_copy` mail
 * legitimately produces no `messages` row, so nothing else in the system notices. A message the
 * user actually sent left their view permanently. This table is the durable half.
 *
 * ── THE COLUMNS THAT ARE NOT HERE ─────────────────────────────────────────────────────────────
 *
 * No subject, no sender, no Message-ID, no bytes, and no free text anywhere. A row is a COORDINATE
 * — mailbox, folder, server epoch, UID — plus a `code` the database itself holds to a closed set.
 * `mailbox_id` scopes it for the same reason every other locator read is mailbox-scoped: a
 * `(folder, uid)` pair repeats across every mailbox on the planet.
 *
 * **This table is never granted to the admin console's role.** The information is in the row's
 * EXISTENCE, not in a column, so no narrower projection closes it: an unparseable probe plus a poll
 * confirms delivery to a named mailbox. That is the oracle that retired `public.messages` from
 * `STAFF_SELECT_GRANTS` entirely, and it applies here unchanged.
 *
 * ── `next_attempt_at IS NULL` MEANS "NO CLOCK-RETRY", NOT "NEVER AGAIN" ───────────────────────
 *
 * Due is `resolved_at IS NULL AND (next_attempt_at <= now() OR attempted_version IS DISTINCT FROM
 * <this build>)`. The version arm is what makes a deploy carrying a parser fix reach the mail it
 * fixes, and it is self-disarming — an attempt stamps `attempted_version`, so it fires once per
 * build. The two REACHABLE failures are deterministic in the raw bytes, so they are born with a
 * NULL instant and woken by the version arm alone; a clock cannot change their answer and each
 * attempt would re-download the body it is about to refuse. `attempts` is the escalation signal,
 * derived rather than stored as a flag so it cannot disagree with itself.
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
 * ── THE RECONCILE BACKOFF PAIR, ON BOTH DESIRED-STATE TABLES (mail 0058) ────────────────────
 *
 * `attempts` / `next_attempt_at` are the durable half of the reconciler's per-item failure
 * isolation, and they are on BOTH `folder_state` and `flag_state` because the queue behind each
 * one starves the same way.
 *
 * A pending row is an IMAP mutation the worker still owes the server. When the server refuses one
 * particular mutation — a source folder that is read-only, an EXPUNGE the host will not perform, a
 * destination it will not accept — retrying it changes nothing, and retrying it EVERY CYCLE costs
 * an IMAP round trip per cycle for ever. Worse, `listPendingFolderStates` is ordered oldest-first
 * under a fixed per-cycle budget (`RECONCILE_MOVES_PER_CYCLE`), so immortal rows collect at the
 * HEAD of that budget and eventually consume all of it: mail the user filed a minute ago never
 * reaches their server because the reconciler spends its whole allowance re-refusing rows from
 * last week. That is head-of-line blocking by budget rather than by exception, and no amount of
 * per-item `try`/`catch` in the worker fixes it — the queue query has to be able to SKIP a row.
 *
 * So a refused mutation is deferred rather than abandoned:
 *
 *   attempts         how many times THIS mutation has been refused. Bounded backoff reads it;
 *                    the audit row publishes it, so a permanently stuck message is visible as a
 *                    number rather than as a repeating log line.
 *   next_attempt_at  when it may be attempted again. NULL ⇒ DUE NOW, which is what every row is
 *                    born as and what every row is reset to the moment the user expresses fresh
 *                    intent (`upsertFolderState` clears both columns on write). The pending
 *                    queries add `next_attempt_at IS NULL OR next_attempt_at <= now()`.
 *
 * **The row is never dropped, and the backoff has a floor, not a cliff.** There is no "gave up"
 * state and no terminal status: `reconcile_status` stays `pending`, the row keeps counting toward
 * `MailboxDTO.pendingMoves`, and the retry interval tops out at a few hours
 * (`nextReconcileAttemptAfter`, `apps/worker/src/sync.ts`). A user's move is their state and this
 * product does not discard it — a host that starts accepting the mutation next week converges then.
 * Deferral is about how OFTEN we ask, never about whether we still owe it.
 *
 * Deliberately no error column. What went wrong is free text from someone else's mail server; it
 * belongs in the `reconcile.move.failed` / `reconcile.flags.failed` audit row, which is where it
 * already goes. These two columns are a schedule, and a schedule is a coordinate.
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
}, (t) => ({ uqMessage: unique().on(t.messageId) }));

/**
 * READ-STATE DESIRED STATE — `folder_state` for the `\Seen` flag (mail 0024).
 *
 * The shape is deliberately `folder_state`'s, column for column, because the problem is the
 * same problem: the API may never open IMAP, so a client that marks mail read can
 * only write down what it WANTS and let the always-on worker put it on the server. Before this
 * table `PATCH /messages/:id {unread}` wrote `messages.unread` and stopped there — the flag
 * never reached the mailbox in either direction, so the guarantee that "read/seen flags survive
 * everything" was false, and mail the user had read for years came back as
 * "New" on first sync because ingest dropped the adapter's `seen`.
 *
 *   desired_seen    what the USER asked for. Written by the API (and by ingest, at create).
 *   observed_seen   what the SERVER last said. Written by the worker only.
 *   last_set_by     'us' | 'external'. `reconcileMailbox` refuses to push a row it did not
 *                   author — the same user-wins rule the folder reconciler applies, and the
 *                   reason an unread-again in Apple Mail is not silently reverted by us.
 *   reconcile_status 'pending' | 'reconciled'. Derived from desired vs observed at every write,
 *                   never set by hand, so a row can never claim convergence it does not have.
 *   conflict        reserved, mirroring `folder_state`; nothing sets it true yet.
 *
 * One row per message (`unique(message_id)`), because there is one flag and the last writer
 * wins. `messages.unread` stays the READ model the DTO and the view partitions project — this
 * table is the write intent behind it, exactly as `folder_state.desired_folder` sits behind
 * `MessageDTO.folder`.
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

  /* ── mail 0034 — APPLYING A RULE TO MAIL THAT IS ALREADY FILED ────────────────
   *
   * A rule has always been consulted when mail ARRIVES and never afterwards, so writing one
   * left the mailbox exactly as it was. The required behaviour is the opposite, and it is about
   * the DEFAULT: creating a rule should apply it to ALL messages, future and previous, so the
   * mailbox is managed efficiently — and that is the default rather than an opt-in.
   *
   * These four columns are the whole of the durable state for that. `retro_requested_at` set
   * with `retro_done_at` NULL is the ONE definition of owed work; the worker's retro-apply pass
   * is the only writer of the other three, and `RulesService` the only writer of the first.
   *
   *   retro_requested_at  the user asked for this rule to reach mail already on disk.
   *   retro_done_at       the pass finished. Written LAST, on 0030's rule: claiming it first
   *                       makes a crash permanent — a rule marked applied with most of its
   *                       mail unmoved and nothing that would ever look again. Written last, a
   *                       crash re-runs, and re-running is safe because the candidate query is
   *                       itself the idempotency (a message already desired into the rule's
   *                       destination is no longer a candidate).
   *   retro_cursor        resume point: the last `messages.id` of the last COMMITTED page.
   *                       ACCOUNT-scoped, not mailbox-scoped, because `rules.account_id` is the
   *                       rule's scope — one cursor pages every mailbox on the account, which a
   *                       per-mailbox marker (0025, 0030) could not do.
   *
   *                       KNOWN LIMIT, written here so it is not rediscovered as a bug:
   *                       `messages.id` is a random UUID, so it is monotone only WITHIN one
   *                       run's ordering. A message ingested after the cursor has passed its id
   *                       — a backlog still draining — is skipped by this pass for ever. That
   *                       is acceptable (a rule routes new mail at arrival, which is the
   *                       ordinary path) and it is a second reason no copy anywhere may say
   *                       "every message".
   *   retro_moved         desired-state rows this rule's pass has written. Reported, not read.
   *
   * `rules` is a MAIL table, so these columns ship to the desktop LOCAL engine too, where
   * nothing writes them yet. That is deliberate and has precedent — `messages.auth_verdict`
   * landed the same way, ahead of its reader — and is recorded here so the next reader does not
   * file it as dead schema.
   */
  retroRequestedAt: timestamp("retro_requested_at", { withTimezone: true }),
  retroDoneAt: timestamp("retro_done_at", { withTimezone: true }),
  retroCursor: uuid("retro_cursor"),
  retroMoved: integer("retro_moved").notNull().default(0),

  /* ── mail 0050 — A SECOND TERM ON A SENDER RULE: THE SUBJECT ────────────────────
   *
   * One sender sends two kinds of mail. `info@` at a small host is the invoice AND the
   * `[NinjaFirewall]` alert every night; a sender rule can only say "all of it goes to Reads",
   * which files the invoice with the alerts. The requirement is a rule that says BOTH things:
   * *from this address AND with this in the subject*.
   *
   * NULL is the resting state and means "no subject term" — which is the truth for every rule
   * that existed before this column and is byte-identical to the pre-slice router. There is no
   * backfill and there can never be one: a term invented for an existing rule would NARROW a
   * decision the user made about a whole sender, silently un-filing their mail.
   *
   * ── IT IS A CONJUNCTION, WHICH IS WHY IT IS SAFE TO ADD ────────────────────────
   *
   * `core/src/rules.ts#matches` reads it as an EXTRA term a rule must satisfy, never as an
   * alternative one: a present term can only make a rule fire LESS often than it did. So the
   * column cannot widen anybody's routing, and a row whose term nothing understands (an older
   * engine reading a newer database) simply keeps matching on the sender alone — which is the
   * pre-column behaviour and not a bypass.
   *
   * ── AND IT CHANGES THE ORDER, WHICH IS THE HALF THAT NEEDED A DECISION ─────────
   *
   * A subject-carrying sender rule OUTRANKS a bare sender rule for the same address
   * (`compareRules`, mirrored in `drizzle-repo.ts#listRules`' `ORDER BY`). Without that, writing
   * "from info@… AND subject contains [NinjaFirewall] → Reads" beside an existing
   * "from info@… → Ohbox" would be a coin toss decided by a UUID tie-break: the more specific
   * statement has to win, or the feature does not work at the only moment anybody reaches for it.
   *
   * The CHECK forbids the empty and whitespace-only string, so "no term" has exactly one
   * representation (NULL) at the storage layer rather than three the readers must each agree
   * about. The 200-char ceiling is a refusal to store a subject-length haystack as a needle.
   *
   * A MAIL column, so it ships to the desktop LOCAL engine with the rest of `rules`. Unlike the
   * `retro_*` family above it has a reader there from day one: the local engine runs this same
   * `evaluateRules`.
   */
  subjectContains: text("subject_contains"),

  /* ── mail 0052 — THE OTHER HALF OF THE SAME REQUIREMENT: THE MESSAGE TEXT ───────
   *
   * `subject_contains` above splits one sender by subject. Some senders defeat that by writing
   * the SAME subject on every message — "Notification", "Alert" — and putting the distinguishing
   * text in the body. This column is the same conjunction one field deeper: *from this address
   * AND with this in the message text*.
   *
   * Everything the 0050 comment says holds here unchanged, deliberately: NULL is the resting
   * state, there is no backfill and can never be one, `core/src/rules.ts#matches` reads it as an
   * EXTRA term above the kind switch so a present term can only make a rule fire LESS often, and
   * the CHECK (`rules_body_contains_nonempty`) makes NULL the only representation of "no term".
   *
   * ── WHAT IT IS MATCHED AGAINST, WHICH IS THE ONE NEW DECISION ──────────────────
   *
   * The message's canonical PLAIN TEXT: `NormalizedMessage.textBody` on arrival, which is the
   * byte-identical string `message_bodies.text` stores (mailparser's text part, or its html→text
   * derivation for html-only mail). The retroactive passes read that stored column back, so
   * arrival and retro consult the SAME haystack. A message whose body is not on disk reads as
   * `""`, which satisfies no term — the fail-closed direction for a narrowing conjunct: the rule
   * declines to fire and the mail stays where it is.
   *
   * In the order, a body term counts exactly as a subject term does — below `kind`, above
   * `provenance` — with the subject clause ranked first, so a rule carrying both terms outranks
   * subject-only, which outranks body-only, which outranks bare. Same 200-char ceiling: a term
   * is a needle, and the haystack being bigger is not a licence to store a bigger needle.
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
 * The `classid` half of `pg_advisory_xact_lock(int4, int4)`, the SECOND half `hashtext(account_id)`
 * — the pattern `STAGING_QUOTA_LOCK_CLASS` and `PROFILE_IMPORT_LOCK_CLASS` already use.
 *
 * Serializes ACCOUNT ERASURE against the THREAD BACKFILL, and nothing else. Both are the only
 * two writers that ever lock a whole account's worth of `threads` or `messages` rows in bulk,
 * and they lock the two tables in OPPOSITE orders for reasons neither can give up: erasure's
 * DELETE order is forced child-before-parent by the FKs (`messages` before `threads`), while the
 * backfill locks an unthreaded `messages` row first because — being unthreaded — there is no
 * `threads` row yet to lock ahead of it (`listThreadBacklog`, `packages/core/src/adapters/
 * drizzle-repo.ts`). Interleaved, that is a genuine lock cycle: erasure holds every thread row
 * and waits on a message row the backfill is mid-resolve on, while the backfill holds that
 * message and waits on the very thread erasure is about to attach it to.
 *
 * Every OTHER writer of a thread (ingest, the user's own merge, the worker's join heal) locks
 * `threads` before `messages` — one shared order among themselves — and none of them ever locks
 * more than the few rows one message or one merge group touches, so none of them needs this
 * lock: the risk this guards against is specific to a WHOLE-ACCOUNT sweep meeting the one path
 * that is structurally message-first.
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
   * THE CONVERSATION'S ROOT Message-ID — the find-or-create conflict anchor (mail 0026).
   *
   * The leftmost (oldest) entry of the arriving message's `References`, else its `In-Reply-To`,
   * else its own Message-ID. Leftmost and not rightmost is the whole reason out-of-order ingest
   * converges: a 4-deep chain A <- B <- C <- D arriving as D, B, A, C derives `a` from all four,
   * so all four find one row; keyed on the rightmost they would derive `c`, `a`, `a`, `b` and
   * split one conversation into three threads.
   *
   * Before it, `threads` had no natural key and a find-or-create could only be SELECT-then-
   * INSERT — two mailboxes of one account syncing in parallel both miss and both insert. NULL
   * only for a message carrying no Message-ID at all, and NULLs are DISTINCT in a Postgres
   * unique index, so each of those is its own singleton rather than all of them colliding.
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
   * ── Mail 0062: WHY THIS ROW HOLDS NO CONTENT — the managed storage cap's honest marker ──
   *
   * NULL for every ordinarily stored body. `'storage_cap'` means this message's text/html is
   * not in the hosted store BECAUSE OF the account's managed storage cap — since the 2026-08-21
   * rolling-window ruling that is almost always an EVICTED husk (the body was stored, then aged
   * out of the window as new mail needed the room, `storage.ts#evictOldestBodies`), and only at
   * the pathological ceiling a declined-new one (`reserveBodyBytesEvicting`'s bound). One marker
   * for both deliberately: the REASON is the cap either way, and every consumer below already
   * says the right sentence for both. The row still
   * carries the real `headers` (the organizing passes read stored headers; declining them would
   * silently break unsubscribe/screener/consent/away on exactly the mail the cap touches) and
   * `text = ''`/`html = NULL`, and the message on the IMAP server is UNTOUCHED (the mailbox is
   * the master; the cap governs OUR copy only).
   *
   * A marker column and not "no row", three times over: no-row is indistinguishable from "not
   * yet mirrored" (the sidecar's gap query would re-ask forever), the DTO must say WHY the text
   * is empty (an empty body claiming to be complete is the lie this column ends), and a future
   * ratified restore pass is then an UPDATE in place (`redacted-restore.ts`'s exact shape) with
   * `WHERE withheld_reason = 'storage_cap'` as its predicate. The repair passes that re-fetch
   * bodies from IMAP must SKIP rows where this is non-null — they repair damage, and a withheld
   * row is policy, not damage.
   *
   * ── Mail 0065 adds two more members to the closed set, same shape, different sentences ──
   *
   *  · `'junk_filed'` — the spam verdict filed this message to the provider's native `\Junk`
   *    (imap-types.ts, the 2026-08-22 amendment). The durable artifact of a spam verdict is the
   *    SENDER RULE, never the body: the bytes live on in the provider's Junk folder, which is
   *    the master, and holding a hosted copy of mail the user judged spam is storage against no
   *    product surface. Written ONLY after the IMAP move landed — a husk claiming Junk while the
   *    message still sits in a watched folder would be the mirror lying about the mailbox.
   *  · `'expunged'` — the worker observed every watched instance of this message gone from the
   *    server (`tombstoneInstanceless`). The row is tombstoned (`messages.deleted_at`) in the
   *    same transaction; the husk exists so the account stops paying for bytes of a message the
   *    mailbox no longer holds.
   *
   * Both keep real headers and release their bytes exactly as `'storage_cap'` does. A row that
   * is ALREADY withheld keeps its first reason — the content is already gone, and rewriting the
   * marker would erase which policy took it.
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
   * WHEN THE AI QUESTION WAS ANSWERED for this account, or NULL for "nobody has been asked"
   * (migration 0084).
   *
   * `accounts.ai_enabled` says whether AI is ON. It cannot say whether anybody was ASKED,
   * because its resting value is `true` (`NOT NULL DEFAULT true`, and `aiEnabledFor` falls back
   * to `true` for a missing row) and a resting value is indistinguishable from an answer. The
   * onboarding posture needs both facts — `OnboardingAi` is a four-state union precisely because
   * "answered no" and "never asked" select opposite screens — and one boolean cannot carry two
   * independent facts however it is read.
   *
   * The measured cost of not having it: a fresh hosted account reported `on`, so
   * `deriveOnboardingStep`'s AI row never fired and the question was never asked at all, on an
   * account whose AI was already spending its credits.
   *
   * READ AS `IS NOT NULL`, never as a deadline — `autoSuggestAt`'s rule directly above, and for
   * its reason: a skewed clock must not be able to turn it into a different answer.
   */
  aiAnsweredAt: timestamp("ai_answered_at", { withTimezone: true }),
  /**
   * THE ERASURE FENCE (migration 0079). NULL for every live account; the instant of the account's
   * Art. 17 erasure otherwise — stamped FIRST inside `deleteAccount`'s transaction, with
   * `coalesce` so a retried erasure keeps the first stamp.
   *
   * This row SURVIVES erasure by design (the pseudonymous billing subject), so nothing structural
   * refuses a late writer: without this column, a consent-settings PATCH in flight across the
   * erasure could recreate `account_settings` / doorbell rows a millisecond after the catalog
   * sweep counted zero. Every settings writer opens its transaction by reading this row
   * `FOR SHARE` and refusing on a stamp (`erasure-fence.ts`); the stamp-first order means
   * whichever side wins the row lock, zero rows survive. The migration file carries the full
   * two-sided argument.
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
   * WHEN this address was proven to be real and to belong to this account (migration 0023).
   *
   * `NULL` means unproven. Two things write it and neither ever writes it back to `NULL`
   * (verification is monotonic — the writers `COALESCE`):
   *
   *  · `AuthService.register` on the INVITE path, at creation. The invite row is email-BOUND
   *    and was mailed to that address by the invite flow, so consuming it inside the account-creating
   *    transaction IS the proof. The unbound `cfg.inviteCodes` bootstrap
   *    is deliberately NOT covered — it proves nothing about an address.
   *  · `AuthService.verifyEmail`, on a token that was mailed to the address PLUS the account
   *    password. Both halves are required; see that method for the pre-hijack it closes.
   *
   * It is a timestamp and not a boolean because the column answers "how long has this account
   * been able to spend money", which is the question an abuse investigation actually asks.
   *
   * READ by `resolveSession` (so the privilege travels with the session at no extra query) and
   * enforced by `withVerifiedEmail` on `POST /billing/checkout` and `POST /mailboxes`.
   */
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uqEmail: unique().on(t.accountId, t.email),
  /**
   * THE LOGIN IDENTITY, and the only constraint that actually enforces it (migration 0021).
   *
   * `uqEmail` above cannot: `register` inserts a fresh `accounts` row before the `users` row,
   * so no two registrations ever share an `account_id` and the composite is satisfied by
   * construction whatever the address. Before this index the sole guard was an unlocked
   * SELECT-then-INSERT, which two concurrent registrations for one address (using two live
   * invites — `invite mint --force` used to leave both working) both pass. `login` then does
   * `where email = $1 limit 1` with no ORDER BY, so the password opens an arbitrary one of
   * the two accounts.
   *
   * Unique, and it REPLACES the old non-unique `users_email_idx` rather than joining it: the
   * old index was the same single column and could only cost writes.
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
 * REFRESH TOKENS (mail 0060 — moved from the Cloud half) — the rotating-refresh history per
 * session family. A presented refresh token that is already `consumedAt` ⇒ reuse ⇒ the whole
 * family is revoked (`packages/services/src/auth/session-lifecycle.ts`).
 *
 * MAIL-half since Phase 3, and not by analogy: QR device pairing signs a REMOTE device into
 * the desktop-as-host tier, and that device's bearer pair rotates against the store that serves
 * it — the desktop arm runs the mail journal only, the same argument that put `users`/`devices`/
 * `sessions`/`pairing_tokens` here. The old placement's justification ("a local install mints a
 * session per launch: no refresh rotation") was true until paired devices existed and is false
 * now. What stays private is the identity CEREMONY — password hashes, login tokens, factors,
 * PKCE codes: everything that proves WHO somebody is. A refresh row proves nothing about
 * identity; it is a digest of a credential this same database minted, exactly the
 * `sessions.access_token_hash` / `pairing_tokens.token_hash` discipline.
 *
 * The hosted database already has this table from cloud 0000; mail 0060 creates it guarded, so
 * either journal order converges on one catalog object (the migration's own header carries the
 * mechanics). Per-table justification lives in `test/journal-split.test.ts` beside the partition.
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
 * PAIRING TOKENS (mail 0059) — the consumable credential behind every pairing ceremony: the
 * standalone server's first-account setup token, a family invite, and QR device pairing.
 *
 * MAIL-half and not by analogy: a pairing token is redeemed against the server that will serve
 * the resulting session, and the desktop-as-host arm runs the mail journal only — the same
 * argument that put `users`/`devices`/`sessions` here. It is NOT part of the identity ceremony
 * (that stays Cloud): its whole authority is its own entropy, single-use + TTL, exactly like an
 * invite.
 *
 * The discipline is `login_tokens`': `tokenHash` is sha256 of a ≥128-bit random value that is
 * returned ONCE at mint and never stored; redeem is one atomic
 * `UPDATE … SET consumed_at = now() WHERE token_hash = $1 AND "grant" = $2 AND consumed_at IS
 * NULL AND revoked_at IS NULL AND expires_at > now() RETURNING`, so the row lock decides a race
 * and a token can only be spent as the grant it was minted with. `createdByUserId` is NULL for
 * exactly one mint — the first-boot setup token, made by the composition root before any user
 * exists — and REQUIRED for `device-pair`, whose redeem mints a session for the creator. The
 * grant CHECK ('invite' | 'device-pair') lives in the migration. See
 * `packages/services/src/pairing.ts` for the lifecycle and its bounds.
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

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0010 — reference & compose niceties. Five additive,
// account-scoped tables served purely over REST (no change_log / EntityType
// growth — the mailbox/tracker precedent): clients refetch rather than sync.
//
// `contact_notes` / `thread_notes` are the free-text notes pinned to a contact
// reference card or a thread; PATCH/DELETE /notes/:id resolves an id in EITHER
// table (account-scoped). `snippets` is the compose-time canned-text library.
// `notify_rules` opts specific senders/threads back INTO notifications (off by
// default). `away_responders` is the single per-account autoresponder
// row (UNIQUE(account_id) ⇒ PUT upserts it).
// ─────────────────────────────────────────────────────────────────────────────

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
   * WHO GETS AN AUTOMATIC REPLY — `'screened_in'` (the default) or `'everyone'` (mail 0051).
   *
   * `screened_in` means only a sender the account has already let past the Screener: a message
   * still HELD in `ohmail/Screener` gets no reply. That is the default because the Screener is a
   * consent gate in both directions — a stranger who has not been admitted has not been told
   * anything about this account, and an away reply tells them somebody is travelling and that the
   * address is live and read by a person. `everyone` is the explicit opposite choice, and it is
   * only ever reachable by someone changing this field.
   *
   * NOT NULL with a default rather than a nullable column, because unlike every `account_settings`
   * flag this one is not an on/off — an absent value would have to mean one of the two members, and
   * a reader that guessed differently from the writer would widen an audience nobody widened. The
   * CHECK (a closed two-member enum) lives in the migration.
   */
  audience: text("audience").notNull().default("screened_in"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uqAccount: unique().on(t.accountId) }));   // one row per account ⇒ PUT upserts

/**
 * THE AT-MOST-ONCE RECORD FOR AUTOMATIC REPLIES (mail 0051) — one row per
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
   * `sha256(decoded bytes)`, hex — mail 0028.
   *
   * Computed in `packages/core/src/mime.ts#toAttachmentMeta`, the one moment the bytes are
   * resident, because the privacy rules forbid persisting them and no later job can recover them. It is
   * the attachment half of {@link messageFingerprint}: without it two messages identical in every
   * header and body but carrying DIFFERENT files of the same name, type and size share one logical
   * identity, and the second is filed as a duplicate and never shown.
   *
   * NULLABLE and NOT backfilled. Every row written before this migration has no digest and none
   * can be invented — the bytes are gone. That is exactly why the fingerprint is never computed
   * from stored columns; see the migration header.
   */
  contentSha256: text("content_sha256"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  ixMessage: index("attachments_account_message_idx").on(t.accountId, t.messageId),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0012 — Knowledge Base + manual drafts (the NO-AI foundation
// for the drafts feature; the AI drafter + gated send land later).
//
// `kb_entries` — the account's knowledge base: free-text title/content the AI
// drafter will later retrieve over for grounded replies. A DB-managed `kb_tsv`
// `GENERATED ALWAYS AS (…) STORED` tsvector (mirroring 0008's subject/body_tsv) +
// its GIN index back `KbService.retrieve` (KB has its OWN lexical
// retrieval, NOT routed through SearchService's messages joins). Core Postgres —
// no CREATE EXTENSION — so it replays into PGlite. REST-only (no
// `change_log` / EntityType growth); clients refetch.
//
// `drafts` — a STORED, never-auto-sent reply. `mailboxId` is NOT NULL (an
// account may have >1 mailbox; send must pick the identity/SMTP). `status`
// (draft|sending|sent|unverified) is the send-progress state a `draft` change_log
// row surfaces to clients. `to`/`cc` are `EmailAddress[]` JSON.
// ─────────────────────────────────────────────────────────────────────────────
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
  // ── Mail 0077 — SEND LATER: the draft carries WHEN it should leave. `send_at` + `status =
  // 'scheduled'` are written together by `ScheduleService.schedule`; the worker's scheduled-send
  // pass claims due rows and runs the ordinary gated send. `send_key` is the send's
  // Idempotency-Key, minted AT SCHEDULE TIME so a crashed claim retries with the same key and
  // replays instead of re-delivering; both survive the claim (crash-recovery predicate) and are
  // cleared on a terminal outcome or a cancel. `send_error` is the failure sentence from an
  // appointment that could not be kept, shown in the Drafts row, cleared by the next edit or
  // schedule. The appointment lives HERE and never on `outbound_sends`, whose `pending` rows mean
  // "an invocation is live right now, OR one died holding this" — no reservation exists until the
  // appointment is due, and the reconciling pass (`send-reconcile-pass.ts`) is what tells the two
  // apart, ten minutes on. The stuck-send alarm reads the RESIDUE of that: a row still `pending`
  // past its threshold is one the reconciler has not drained, not merely one that is live.
  // The migration file carries the full design. ──
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

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0013 — the gated idempotent send state machine. ONE row per
// (accountId, idempotencyKey) send attempt: `UNIQUE(account_id, idempotency_key)`
// is the reservation gate the SendService inserts through with `ON CONFLICT DO
// NOTHING` BEFORE any SMTP call (no network in a tx). `minted_message_id`
// (`<uuid@domain>`) is minted UP FRONT on the pending reservation and passed to
// SMTP as the Message-ID mandated by RFC 5322: a crashed attempt is later VERIFIED by
// searching the Sent folder for exactly that id rather than blindly resent. The
// `status` progression pending → sent captures a delivered+finalized send;
// `unverified` is the terminal AMBIGUOUS outcome (SMTP result unknown, id NOT in
// Sent) surfaced to the user ("couldn't confirm — check Sent before retrying"),
// NEVER auto-resent; `failed` is a definitively-undelivered attempt. This is a
// domain state machine the generic verbatim `idempotency_keys` cache cannot model
// (it has no `pending` state), so `/drafts/:id/send` is NOT idempotent-marked and
// SendService owns this reservation itself.
// ─────────────────────────────────────────────────────────────────────────────
export const outboundSends = pgTable("outbound_sends", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  draftId: uuid("draft_id").notNull().references(() => drafts.id),
  mintedMessageId: text("minted_message_id").notNull(),      // `<uuid@domain>` minted up front
  providerMessageId: text("provider_message_id"),            // the delivered Message-ID (null until sent)
  status: text("status").notNull().default("pending"),       // pending|sent|failed|unverified
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uqKey: unique().on(t.accountId, t.idempotencyKey),         // the per-account idempotency reservation gate
}));

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0014 — workflow automation storage. Two
// additive, account-scoped, REST-only tables (kb_entries/tracker precedent):
// NEITHER writes `change_log` and NEITHER grows `EntityType` — clients refetch via
// `GET /workflows` + `GET /workflow-runs`. The workflow EFFECTS (a `file_message`
// move, a `draft_reply` draft) still sync as their own `message`/`draft` changes;
// only the envelope is REST-only.
//
// `workflows` — a user- (or later AI-proposed-) authored automation. `trigger`/
// `steps` are jsonb (WorkflowTrigger / WorkflowStep[] — the ONLY tools a step may
// declare are file_message/draft_reply/add_kb_entry; send/forward are rejected at
// the service boundary). `enabled` defaults FALSE (enabling IS the user's
// consent to auto-apply). `deletedAt` is the SOFT-DELETE marker: a DELETE
// nulls-out nothing physical so `workflow_runs` history + its `audit_log` inverses
// survive; every read excludes `deletedAt IS NOT NULL`.
//
// `workflow_runs` — one row per enqueued run. `POST /workflows/:id/run` inserts a
// `pending` row (a separate worker drains them); a retried
// Idempotency-Key replays the same runId (the row + the `idempotency_keys` verbatim
// response commit in ONE tx, mirroring MessageService.move). `workflowId` is
// NULLABLE (a soft-deleted workflow's runs are retained, FK set to no-action).
// `stepCursor` is the durable per-run resume cursor; `log` is the convenience
// step index for the run DTO (the canonical inverse home is `audit_log`).
// ─────────────────────────────────────────────────────────────────────────────
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
  // ── mail 0033 — WHEN THE `running` CLAIM WAS MADE ──
  //
  // Written once, by the drain's guarded `pending → running` UPDATE, and read only by the
  // reaper that requeues a run whose worker died holding it (`workflowDrainPass`). It exists
  // because neither existing column can answer "how long has this been unattended": `createdAt`
  // dates the ENQUEUE, so a run drained out of an hour-old backlog would read as stale the
  // instant it was claimed, and `finishedAt` is precisely the column a stranded row lacks.
  //
  // NULLABLE with no default, and both halves are load-bearing. A default would stamp every
  // `pending` row at insert with a claim no worker ever made. NULL means "claimed by code that
  // predates this column" — the runs already stranded when this column shipped, plus anything the old
  // build claims during the deploy window — and the reaper resolves those through `createdAt`.
  //
  // **WRITE IT ONLY FROM A JS `Date`.** Never `defaultNow()`, never `sql`now()``, never a copy
  // of another column. The reaper's guarded requeue re-asserts the stamp it observed, and that
  // observation round-trips through a millisecond-precision JS `Date`: a value carrying
  // microseconds (which is what `now()` stores) can never be matched again, so the row is
  // selected as stale on every pass and requeued on none of them. Silently, and with no test
  // able to see it. Migration `0033` names the measurement.
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
}, (t) => ({ ixAccountStatus: index("workflow_runs_account_status_idx").on(t.accountId, t.status) }));

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0016 — AI workflow PROPOSALS. The AI proposer
// reads NON-SENSITIVE pattern METADATA only (sender/domain/destination/count/
// provenance from learning_signals/routing_decisions/rules — never bodies/snippets)
// and stores suggested automations here. A proposal is INERT: it is NEVER a workflow
// until the user explicitly `POST /workflows { fromProposalId }`, which materializes
// it into a `provenance='proposed', enabled=false` row (never auto-enabled). REST-only
// (kb_entries/tracker precedent): no change_log / EntityType growth — clients
// refetch via `GET /workflows/proposals`. `sourcePattern` records the redacted metadata
// the suggestion was derived from (audit/UI only). `status` open|materialized|dismissed.
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0031 — TAGS. OURS, never IMAP.
//
// ══ THE RULING THIS SCHEMA ENCODES ═════════════════════════════════════════
//
// A tag is a row in OUR Postgres, keyed by message. It is NEVER an IMAP folder,
// and that is the whole reason these two tables exist rather than a sixth entry
// in the fixed `ohmail/*` folder set. ohmail organizes the mailbox IN PLACE with
// exactly `ohmail/Screener|Reads|Receipts|Screened|Quarantine` + `INBOX`
// ("the IMAP mailbox is the master"); a tag is a cross-cutting
// dimension OVER those places, not a seventh place. Writing tags as folders
// would also make them a per-message IMAP COPY, which is exactly the mailbox
// rewrite leave-anytime exists to refuse.
//
// The honest consequence, which the UI states rather than hides: because a tag
// lives only here, it is not in the mailbox. It survives a DISCONNECT — that is
// a soft delete to `status='disabled'` (see `mailboxes.status`) and re-enabling
// is supported, so deleting on disconnect would destroy data on a reversible
// action — but it does NOT survive account erase, and it does not outlive its
// message. `apps/webapp/messages/en.json` says so in those terms.
//
// ══ NO `class_name` COLUMN ═════════════════════════════════════════════════
//
// `TagDTO.className` is presentation the fixture world carries; a CSS class is
// not account data and a server has no business minting one. `hue` is the stored
// dimension and the client maps it (`format.ts:hueOf`). The DTO field is now
// optional so the fixture adapter keeps compiling.
// ─────────────────────────────────────────────────────────────────────────────
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
 * The assignment. PK `(message_id, tag_id)` — the natural key, and the thing that
 * makes a double-assign a no-op instead of a duplicate row: `INSERT … ON CONFLICT
 * DO NOTHING` on this PK is what carries two concurrent toggles of the SAME tag on
 * the SAME message, with no read-modify-write and therefore no lost update.
 *
 * `account_id` is DENORMALIZED onto the row deliberately. Every read is
 * account-scoped and the materialize path fetches labels for a page of
 * messages at once; carrying the account here means that lookup is one index scan
 * on `(account_id, message_id)` instead of a join back through `messages` on every
 * page of every sync drain.
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
 * AUTO-UNSUBSCRIBE'S AT-MOST-ONCE RECORD — mail 0032.
 *
 * One row per (mailbox, list) the account has ever asked to leave. The migration carries the
 * full argument; the two things worth repeating where the code reads them:
 *
 * `uqMailboxList` IS THE CONCURRENCY DESIGN, not an optimisation. The claim is `INSERT … ON
 * CONFLICT DO NOTHING RETURNING id`, so two workers racing the same list both attempt it,
 * exactly one gets a row back, and the loser sends nothing. There is no `FOR UPDATE` here
 * because there is nothing to lock — the unique index IS the mutual exclusion, which is the one
 * form of it a refactor cannot quietly delete.
 *
 * `listKey` is the RFC 2919 `List-ID` when the sender publishes one, else `lower(from_address)`.
 * NOT the unsubscribe URL: that URL normally carries a per-message token, so keying on it would
 * mint a fresh key per message and send once per message — the exact defect this table prevents.
 * NOT `from_address` alone: senders like `no-reply-kbdtwjmegmd_he…@x.com` vary the address per
 * send, and the user experiences one list.
 *
 * Scoped to the MAILBOX and not the account, because the subscription is: two mailboxes on one
 * account subscribed to the same newsletter are two subscriptions at the sender, with two
 * different tokens. `accountId` rides along for account-scoped reads and for erasure only.
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
 * ONE ROW PER ACCOUNT THAT HAS CHANGED SOMETHING — and no row for anyone who has not.
 *
 * Absence is a legal state and means "all defaults". Every reader must treat a missing row that
 * way rather than as an error, which is why nothing here is backfilled and why the row is
 * created lazily on first write (mail 0035).
 *
 * The table is deliberately GENERAL. Preferences arrive one feature at a time, and the
 * alternative to one table is three tables nobody can name from memory. A new per-account
 * setting is a column here.
 *
 * `dormancyDays` NULL means "use the product default" rather than storing the default, so
 * changing the default moves every account that never touched the dial. Storing it would freeze
 * each account at whatever the default was on the day their row happened to be created — the
 * spec calls this "a dial, not a constant to hard-code", and a snapshot of the default is a
 * constant wearing a dial's name.
 *
 * `seedConfirmedAt` is NOT derivable from "does a rule with provenance 'seeded-from-sent'
 * exist". Unchecking every row and confirming is a real answer — "none of these" — and the
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
  ohboxTidyRequestedAt: timestamp("ohbox_tidy_requested_at", { withTimezone: true }),
  ohboxTidyDoneAt: timestamp("ohbox_tidy_done_at", { withTimezone: true }),
  ohboxTidyCursor: uuid("ohbox_tidy_cursor"),
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
  screenerAutoApplyAt: timestamp("screener_auto_apply_at", { withTimezone: true }),
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
  foldersEnabledAt: timestamp("folders_enabled_at", { withTimezone: true }),
  /**
   * WHEN THIS ACCOUNT FINISHED SCREENING ITS BACKLOG (mail 0056) — the instant the dormancy
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
  screeningBaselineAt: timestamp("screening_baseline_at", { withTimezone: true }),
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
  blockRemoteImagesAt: timestamp("block_remote_images_at", { withTimezone: true }),
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
  loadTrackingPixelsAt: timestamp("load_tracking_pixels_at", { withTimezone: true }),
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
  blockAutoUnsubscribeAt: timestamp("block_auto_unsubscribe_at", { withTimezone: true }),
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
   * WHEN THIS ACCOUNT FINISHED (OR CANCELLED) THE FIRST-RUN FLOW — mail 0083.
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
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
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
