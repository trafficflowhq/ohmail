import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * THE TWO JOURNALS, GOVERNED — the mail-domain half is publishable, the Cloud half is not.
 *
 * Stage 3 of the project's design notes §7 split one migration journal into two so a
 * mail-domain schema can be published to the GPL mirror while Stripe, the credit ledger, the
 * identity ceremony and the ops tables stay private. `drizzle/0018_billing.sql` is what forced
 * it: Cloud logic expressed in SQL cannot live in a journal that ships.
 *
 * A split like that is not finished when the files are in the right folders. It stays correct
 * only while three properties hold, and each of them is checked here because each has a silent
 * failure mode:
 *
 *  1. **Nothing was lost or invented.** The surgery moved 191 statements. A `CREATE UNIQUE
 *     INDEX` dropped on the floor does not fail anything: production ran the original journal
 *     and still has the index, so only databases created AFTERWARDS are missing it —
 *     production and fresh diverge permanently and nothing says so.
 *  2. **`when` is strictly increasing inside each journal.** drizzle 0.36.4's migrator reads
 *     `order by created_at desc limit 1` and applies an entry iff that maximum is BELOW it. An
 *     entry at or under the maximum is skipped FOREVER, with no error. drizzle-kit has emitted
 *     one below its predecessor in this repository before.
 *  3. **The closure rule.** The mail journal must be runnable on its own, first, against an
 *     empty database — that is what a local engine does. So no mail statement may name a
 *     private object. The reverse is legal and common: every `REFERENCES public.accounts` in
 *     the Cloud journal points at a mail table.
 *
 * Property 1 needs the pre-split journal as its oracle, which is why {@link LEGACY_DIR} is
 * kept in the tree and read by nothing else. It is also the baseline-adoption evidence.
 *
 * What this file CANNOT see: whether the split changed the resulting SCHEMA. Statements can be
 * present, in order, on the correct side, and still produce a different database — an index
 * built on a table that does not exist yet, say. That is `journal-split.pg.test.ts`, which
 * diffs the whole catalog on real Postgres, and it is the other half of this proof.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));

/**
 * The pre-split journal, retained as the oracle for property 1 and as the adoption evidence.
 *
 * STEP 7 NOTE (see the project's design notes §6): when the migrator is retargeted,
 * `packages/db/drizzle` becomes the CLOUD journal and this folder is renamed to
 * `packages/db/drizzle-legacy`. Only these three constants move.
 */
const LEGACY_DIR = join(HERE, "..", "drizzle");
const MAIL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const CLOUD_DIR = join(HERE, "..", "drizzle-cloud");

/**
 * THE PARTITION — 37 shared tables, 20 private. The single source of truth for which half
 * owns a table, and therefore for the closure rule below.
 *
 * Ruled 2026-07-31. The project's design notes §6 (what survives cancellation) and §7 (the code
 * partition) disagree about four tables — `audit_log`, `outbound_sends`, `tracker_events`,
 * `idempotency_keys` — and **§7 wins**, because §6 answers a different question. The
 * justification for every placement is in `STAGE3-DB-SPLIT.md` §2; the ones worth naming here:
 *
 *  · `devices` is shared because `sessions.device_id` REFERENCES it. Not a judgement — the FK
 *    decides, and dropping it to move the table would change Cloud behaviour.
 *  · `credentials`, `login_tokens` are private. A local install mints a session per launch (§5):
 *    no password login, no first factor. And publishing a `password_hash` column is one-way.
 *    `refresh_tokens` sat on this bullet until mail 0060 (Phase 3): "no refresh rotation"
 *    stopped being true the day QR pairing signed a remote device into the desktop-as-host tier,
 *    so the table moved to the shared half — see its `MAIL_TABLES` entry. The `token_hash`
 *    argument moved with the same event mail 0059 already recorded: the shared half carries that
 *    column name on `pairing_tokens`, so it no longer discriminates the private half.
 *  · `mailbox_credentials` is shared because §5 rules desktop uses the SAME envelope
 *    encryption Cloud does — one credential-at-rest design, not two.
 */
const MAIL_TABLES = [
  // IMAP + the pipeline
  "mailboxes", "mailbox_credentials", "mailbox_folders", "messages", "message_bodies",
  "threads", "folder_state", "attachments",
  // The user-commanded folder verbs' command table (mail 0074) — MAIL beside the
  // `mailbox_folders` inventory its rows are commands about; the worker executes and deletes.
  "folder_ops",
  // The stored-body byte counter (mail 0062) — MAIL by the same argument as `message_bodies`,
  // whose octets it counts: present on every tier, maintained in the same transaction as every
  // body write, and inert bookkeeping where no managed cap is wired. The CAP itself is the
  // Cloud column `billing_subscriptions.storage_bytes_limit` (cloud 0019), on the other list.
  "account_storage",
  // the client protocol: delta sync + idempotency (§7 names both as shared; §8 makes pending
  // mutations plus their Idempotency-Keys the offline intent queue)
  "account_sync_state", "change_log", "idempotency_keys",
  // routing, learning, triage
  "rules", "routing_decisions", "approvals", "message_states", "graduations",
  "learning_signals",
  // reference + compose
  "contacts", "contact_notes", "thread_notes", "snippets", "notify_rules", "away_responders",
  // The away responder's at-most-once record (mail 0051) — MAIL, and not by analogy: it is keyed by
  // the ACCOUNT and by a correspondent's address, it is written only by the pass that reads
  // `away_responders`, and it sits on the mail side for the reason `unsubscribe_records` does. The
  // record of what was sent on a user's behalf belongs wherever their mail is, and a local install
  // that ever grows a responder needs its own copy or it would answer everyone a second time.
  "away_responder_sent",
  // The away responder's LEDGER and its per-correspondent throttle state (mail 0087) — MAIL, on
  // `away_responder_sent`'s reasoning one line up and with one addition of their own. Both are
  // keyed by the account and by a correspondent's address, and both are written by the pass that
  // reads `away_responders`; but unlike 0051's record they are read by a STANDALONE install too,
  // because the pass now runs in the desktop engine's own drain. A local install that answers its
  // own mail must carry its own reservation and its own throttle state or it would answer every
  // correspondent a second time — which is precisely the argument that put `away_responder_sent`
  // on this side, now load-bearing rather than anticipatory.
  "away_replies", "away_sender_state",
  // A reader's outstanding decisions (mail 0088) — MAIL, and it is the clearest case on this
  // list: the row is bookkeeping about a message in the user's own IMAP mailbox, written and read
  // only by the install that made the decision, and a STANDALONE install reading a mailbox
  // another machine organizes is the primary case the table exists for. Nothing in it is billing
  // and nothing in it is the hosted service's.
  "organizer_requests",
  // A READER'S COPY OF THE ORGANIZER'S PROFILE DOCUMENT (mail 0094) — MAIL, on
  // `organizer_requests`'s own argument and as the other half of the same channel. The row is
  // this install's cache of a document that lives in the user's own IMAP `ohmail/_meta`, read by
  // the install that is NOT organizing so its settings panes render the holder's configuration
  // rather than a local row nothing applies. A standalone desktop or phone reading a mailbox
  // another machine organizes is the primary case, exactly as above; nothing in it is billing and
  // nothing in it is the hosted service's.
  "mailbox_profile_mirror",
  "kb_entries", "drafts", "outbound_sends",
  // The account's claim on the CONTENT of a send (mail 0093) — MAIL, on `outbound_sends`'s own
  // reasoning. It is bookkeeping about the user's outgoing mail, written and read only by the send
  // path, and a STANDALONE install needs it for exactly the reason the hosted service does: the
  // idempotency key it would otherwise rely on belongs to the client, so a reinstall or a cleared
  // store leaves nothing between a second press and a second copy in somebody's inbox.
  "outbound_send_fingerprints",
  // THE JUNK RESCUE'S DESIRED STATE (mail 0115) — MAIL, and structurally so. The row is a command
  // about a message in the user's OWN IMAP Junk folder, recorded by the door the person pressed and
  // executed by whichever install organizes that mailbox — the hosted worker, a desktop engine or a
  // standalone phone, all running the same pass. Nothing in it is billing and nothing in it is the
  // hosted service's: it holds a folder name, an epoch, a UID and a closed status.
  "junk_rescues",
  // The search document (mail 0125) — MAIL: it is a message's own words, built at ingest by
  // whichever install stores the message and by the store-only backfill that runs on every tier;
  // a local store searches its own documents.
  "message_search",
  // The addresses a mailing list posts as (mail 0150) — MAIL: recorded at ingest and by the
  // backfill on whichever store holds the mail, and read by that store's own gate.
  "list_addresses",
  // workflows
  "workflows", "workflow_runs", "workflow_proposals",
  // Tags (mail 0031) — MAIL, and not by analogy: a tag is a row in OUR database keyed by a
  // MESSAGE, so it belongs wherever the messages are. A LOCAL desktop install carries it for the
  // same reason it carries `flag_state` — the user's tags are theirs, and a tag is never an IMAP
  // folder, so there is nothing in the mailbox for a local install to read them back from.
  "tags", "message_tags",
  // Auto-unsubscribe's at-most-once record (mail 0032) — MAIL, and not by analogy: it is
  // keyed by MAILBOX and by the list a MESSAGE named, it is written only by the service that
  // reads those messages' stored headers, and a LOCAL desktop install needs it for exactly the
  // reason Cloud does — without the record, the same install re-POSTs a sender's one-click URL
  // every time it re-screens them. The record of what was sent on a user's behalf belongs
  // wherever their mail is.
  "unsubscribe_records",
  // read-state desired state (mail 0024) — MAIL, and not by analogy: it is `folder_state` for
  // the `\Seen` flag, it is written by the same pipeline and the same reconciler, and a LOCAL
  // desktop install has to carry it or its owner's read/unread clicks never reach their server.
  "flag_state",
  // PHYSICAL identity — mail 0028. MAIL, and not by analogy: it is the set of IMAP
  // locators one logical message occupies, it is written by the same pipeline and read by the same
  // sync loop, and a LOCAL desktop install cannot organize a mailbox without it (the known-set is
  // what stops it re-fetching every declined copy on every cycle).
  "message_instances",
  // the spy-pixel audit trail (pipeline output keyed to `messages`)
  "tracker_events",
  // the USER's undo record — payload/inverse. The OPERATOR trails are private.
  "audit_log",
  // per-account settings (mail 0035) — MAIL, and not by analogy: what it holds today is the
  // dormancy cutline and the record that the sent-mail seed was confirmed, and both are
  // properties of how somebody's MAIL is organised. A LOCAL desktop install screens senders
  // and presents History exactly as Cloud does, so it needs the same dial and the same
  // seed-confirmed marker or it re-offers onboarding on every launch.
  //
  // The table is deliberately general, so this classification will be re-argued the first time
  // a genuinely Cloud-only preference wants a home here. The answer then is a second table on
  // the Cloud side, not a move — the mail half must not lose its settings to reach a billing
  // flag.
  "account_settings",
  // the durable per-message failure ledger (mail 0041) — MAIL, and not by analogy: it is keyed by
  // MAILBOX and by an IMAP locator, it is written and read only by the shared sync loop, and a
  // LOCAL desktop install carries it for exactly the reason Cloud does — the Sent folder's cursor
  // is a UID watermark there too, so without this table a local install loses a skipped Sent
  // message just as permanently.
  //
  // It holds no content of any kind and it is never granted to the console's role — see the
  // schema's own note for why the row's EXISTENCE is the thing that cannot be conceded.
  "message_failures",
  // the bare identity, and nothing more
  "accounts", "users", "sessions", "devices",
  // Pairing tokens (mail 0059) — MAIL, and not by analogy: a pairing token is redeemed against
  // the server that will serve the session it produces, and the desktop-as-host arm runs the
  // mail journal only — the same argument that put the identity core above on this side. It is
  // NOT the identity ceremony (passwords, login tokens and refresh rotation stay private): its
  // whole authority is its own entropy, single-use + TTL, like an invite — but unlike `invites`
  // it binds no email and names no private table, so the mail journal can build it alone.
  "pairing_tokens",
  // Refresh tokens (mail 0060, Phase 3) — MAIL, and not by analogy: a paired device's bearer
  // pair rotates against the server that minted it, and the desktop-as-host arm runs the mail
  // journal only — the same argument that put the identity core and `pairing_tokens` here. It is
  // NOT the identity ceremony (passwords, login tokens, factors and PKCE codes stay private —
  // everything that proves WHO somebody is): a refresh row is a digest of a credential this same
  // database minted, exactly `sessions.access_token_hash`' discipline one table over. The cloud
  // journal's byte-frozen 0000 still CREATEs it for the legacy path; the arbitration is pinned in
  // the closure-rule suite below.
  "refresh_tokens",
  // The unsubscribe drain's two memories (mail 0116) — MAIL, with the pass they serve: the
  // per-message mark beside the list-keyed record, and where the window walk stopped. A device
  // runs this pass over its own store, so neither could live in the private half.
  "unsubscribe_examined",
  "unsubscribe_drain_state",
] as const;

const CLOUD_TABLES = [
  // the identity ceremony + multi-device session machinery (the refresh-token STORE moved to the
  // mail half in mail 0060 — paired devices rotate against the store that serves them)
  "credentials", "login_tokens", "webauthn_credentials",
  "webauthn_challenges", "totp_secrets", "recovery_codes", "oauth_auth_codes",
  "auth_events", "auth_throttle",
  // the money
  "billing_customers", "billing_subscriptions", "credit_balances", "credit_ledger",
  "billing_events",
  // the ops
  "worker_heartbeats", "alert_state", "billing_reconciliation_runs",
  // THE API'S OWN 5xx RECORD (cloud 0033). CLOUD, and it is the easy call for the reason
  // `platform_signals` is: it counts what a HOSTED DEPLOYMENT's API answered, per route, and a
  // local install is one process serving one person with no operator to page. It also carries no
  // `account_id` and can carry none — the error envelope records the fault ABOVE the session, so
  // a route that failed for want of a connection has nothing resolved to attribute it to.
  "api_faults",
  // AN ACCOUNT OWED A SUGGEST VISIT (cloud 0039). CLOUD, because it is the HOSTED worker's
  // scheduling priority — the mark ingest writes when it holds a first-contact sender on an
  // opted-in account, and the cycle's owed-first serve retires. A standalone install runs the
  // same suggest pass at its drain tail, already ingest-driven, so the device store has no cycle
  // to prioritise and must not carry the table. It holds no advice and no money: an account id
  // and an instant, nothing else, and losing a row costs latency, never a suggestion.
  "screener_suggest_owed",
  // WHICH LIFECYCLE NOTICE AN ACCOUNT HAS BEEN SENT (cloud 0040, the wall). CLOUD, because only
  // the managed deployment has a plane to read or a subscription to end: a local install meters
  // nothing, closes nobody and owes no reminder. It holds no mail content and no money — an
  // account id, a closed kind, the plane's anchor instant and a sent stamp — and its PRIMARY KEY
  // is the pass's idempotency, so losing a row costs at most one repeated notice.
  "account_lifecycle_notices",
  // THE TOKENS OF AN ERASED ACCOUNT, BY HASH (cloud 0043). CLOUD, because only a server that
  // erases accounts writes it — a local store has no account erasure and its engine's session
  // door asks through a hook that answers false. It holds a token hash, the pseudonymous id and
  // an expiry; losing a row costs one app hearing 401 where it would have heard 410.
  "erased_bearers",
  // A SPEND THAT BOUGHT NOTHING, AS A DEBT (cloud 0036). CLOUD, and it is the same call the
  // retired `credit_ledger` was: it exists only where an entitlements program does, and a local
  // install meters nothing, charges nothing and can therefore owe nothing. It is the ONE money
  // table left on this side of the boundary, and it holds no money — no balance, no price, no
  // ledger row id, only the release this server would make and whether it was taken. That is the
  // difference between remembering a debt and keeping an account.
  "credit_refund_obligations",
  // THE CREDIT ROLL-UP (cloud 0028). CLOUD, and not by analogy: all three are aggregates OF
  // `credit_ledger`, which is CLOUD, and a local install has no ledger to aggregate — it has no
  // account, no subscription and no metered spend. `credit_rollup_runs` is the hosted worker's
  // own run ledger, which a desktop install has no worker to write.
  "credit_usage_daily", "credit_usage_totals", "credit_rollup_runs",
  // REVENUE IN AND COST OUT (cloud 0029). All three CLOUD, and each for its own reason rather
  // than by analogy with the block above:
  //  · `billing_invoices` is the Stripe invoice mirror. A LOCAL install has no Stripe customer,
  //    no subscription and nothing that could issue an invoice — the whole table is meaningless
  //    off the hosted service, exactly as `billing_events` beside it is.
  //  · `platform_costs` is what OUR vendors charge THIS deployment. A standalone install's
  //    hosting bill is its owner's business and is not a fact this schema has any claim on.
  //  · `ai_usage_daily` is the one worth a second look, because a desktop install DOES make
  //    metered model calls — on the USER'S OWN KEY, against the user's own bill, with no
  //    ledger, no credit and no margin to measure. The table exists to answer "what did serving
  //    our customers cost us", which is a question only the hosted service can ask, and the
  //    recorder that writes it is composed in the two hosted roots and the self-host server —
  //    never in the desktop engine, which is what keeps `packages/core`'s AI client free of it.
  "billing_invoices", "platform_costs", "ai_usage_daily",
  // THE RELIABILITY BOARD'S TWO TABLES (cloud 0030). Both CLOUD, and neither is a close call:
  //  · `alert_pass_runs` records that one of the two ALERT DRIVERS completed a pass. Both
  //    drivers are hosted — the sync worker's in-process timer and the API host's cron route —
  //    and a desktop install runs neither, so the table would hold two rows that are never
  //    written and one rule that can never fire.
  //  · `platform_signals` is what OUR hosting platform served for OUR projects, polled from that
  //    vendor's log store with OUR token. `platform_costs` two lines up is the same argument in
  //    the same words: a standalone install's platform is its owner's business.
  "alert_pass_runs", "platform_signals",
  // Cloud 0048 — the alert drivers' per-day gap history, CLOUD for `alert_pass_runs`' reason.
  "alert_driver_gaps",
  // Cloud 0051 — alert drills and their acknowledgements, CLOUD for the same reason: the two alert
  // drivers' pager is the hosted and the self-hosted server's, and a desktop install runs neither.
  "alert_drills",
  // the funnel
  "waitlist", "invites",
  // always-on push — named in §7 as part of the moat
  "push_subscriptions",
  // STAFF identity for the admin console (cloud 0007). CLOUD, and not by analogy: it is
  // the hosted operations surface's own login. A LOCAL desktop install has no admin console,
  // no operator and nobody to sign in — the whole table is meaningless off the hosted service.
  // Deliberately NOT `users`: the product's auth never queries these, so no product code path
  // can promote a customer into staff.
  "staff_users", "staff_sessions",
  // Cloud 0036 — what an OPERATOR did to a staff account (the second-factor recovery). Cloud for
  // `staff_users`' own reason: a local install has no operator and no staff table to point at.
  "staff_audit_log",
  // Cloud 0047 — staff roles and the staff audit. Cloud for the same reason as the two above.
  "staff_role_grants", "staff_audit_events",
  // ACCOUNT SUSPENSION (cloud 0008). CLOUD, and not by analogy: suspension is an act of the
  // hosted operations surface — a staff member stops serving an account — and it names the
  // `staff_users` actor who did it. A LOCAL desktop install has no operator to suspend anyone, so
  // the whole table is meaningless off the hosted service; and `staff_users` being CLOUD means a
  // mail-journal column carrying the actor is unrepresentable. Deliberately a table and not
  // `accounts.suspended_at`: `accounts` is MAIL, and a cloud migration may not DDL it.
  "account_suspensions",
  // THE OAuth ONBOARDING PAIR (cloud 0009). Both CLOUD, and neither by analogy.
  //
  // `mailbox_oauth_ceremonies` is a REDIRECT ceremony in flight — a `state` this service minted, a
  // PKCE verifier it is holding while somebody is at Microsoft's consent screen, and a return path
  // into the hosted app. A LOCAL install has no redirect ceremony to hold: the desktop flow (phase 4)
  // listens on a loopback port on the machine itself and writes no row anywhere. It sits beside
  // `oauth_auth_codes` and `webauthn_challenges` above, which are the same shape of fact.
  //
  // `oauth_provider_config` is the OPERATOR'S OWN Entra application registration — one client id,
  // secret and tenant for the whole hosted deployment, managed from the admin console. A local
  // install has no operator and nothing to register; and the table names a `staff_users` actor, which
  // (exactly as with `account_suspensions`) makes a mail-journal placement unrepresentable rather
  // than merely undesirable.
  //
  // `mailbox_oauth_device_ceremonies` (cloud 0027) is the DEVICE-CODE half of the same onboarding,
  // and it is CLOUD for a reason that is worth stating because the obvious one is wrong. The flow
  // exists FOR self-hosted operators — but "self-hosted" here means a server running the hosted
  // route table (`selfHostRoutes`) against its own Postgres, which runs BOTH journals. It is not a
  // LOCAL desktop install, which is the distinction this partition is actually about: a local
  // install has no accounts table to bind a ceremony to, no server-side row to poll, and connects
  // its own mailboxes through the loopback listener instead. Placing this in the mail journal would
  // put a table in every desktop database that nothing on that install can ever write into — the
  // same test `attachment_staging` and `ai_attempt_claims` are ruled by below.
  "mailbox_oauth_ceremonies", "mailbox_oauth_device_ceremonies", "oauth_provider_config",
  // ATTACHMENT STAGING (cloud 0015). CLOUD, and structurally so rather than by analogy: it is the
  // row half of a transport that exists ONLY because the hosted API has a serverless request-body
  // limit between its compose form and the wire. A LOCAL install runs the send handler in the same
  // process as its own SMTP dial — there is no request body to stage around, and no object storage
  // to stage into — so a mail-journal placement would create, in every desktop database, a table
  // nothing on that install can ever write a row into. It sits beside `mailbox_oauth_ceremonies`
  // above, which is the same shape of fact: a short-lived, expiring server-side ticket for a
  // ceremony that only the hosted deployment performs.
  "attachment_staging",
  // AI ATTEMPT CLAIMS (cloud 0016). CLOUD, and for the same structural reason `attachment_staging`
  // is: it exists only where there is a CREDIT LEDGER to coordinate. A row says "this caller is
  // inside the paid model call for this unit of work", which is a statement about METERED work —
  // and a local install meters nothing (its auto-suggest pass declares itself unmetered and takes
  // no claim, running against its owner's own model key). In the mail journal this would be a table
  // every desktop database carries and nothing on that install can ever write into.
  "ai_attempt_claims",
  // THE SETUP POOL (cloud 0021). CLOUD, for the same structural reason `ai_attempt_claims` is:
  // it exists only where there is a CREDIT LEDGER beside it. A grant funds METERED screening on
  // the hosted service; a local install meters nothing, so in the mail journal these would be
  // tables every desktop database carries and nothing on that install can ever write into.
  "setup_grants", "setup_grant_spends",
] as const;

const SIDE = new Map<string, "mail" | "cloud">([
  ...MAIL_TABLES.map((t) => [t, "mail" as const] as const),
  ...CLOUD_TABLES.map((t) => [t, "cloud" as const] as const),
]);

interface JournalEntry { idx: number; version: string; when: number; tag: string; breakpoints: boolean }

function journal(dir: string): JournalEntry[] {
  const raw = readFileSync(join(dir, "meta", "_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

/** Statement chunks EXACTLY as drizzle's `readMigrationFiles` produces them. */
function chunksOf(dir: string, tag: string): string[] {
  return readFileSync(join(dir, `${tag}.sql`), "utf8").split("--> statement-breakpoint");
}

function allChunks(dir: string): Array<{ tag: string; i: number; sql: string }> {
  const out: Array<{ tag: string; i: number; sql: string }> = [];
  for (const e of journal(dir)) {
    chunksOf(dir, e.tag).forEach((sql, i) => { if (sql.trim()) out.push({ tag: e.tag, i, sql }); });
  }
  return out;
}

/**
 * STATEMENTS AUTHORED AFTER THE SPLIT — every one of them, by exact content hash.
 *
 * The permutation oracle below compares the two journals against `packages/db/drizzle`, the
 * pre-split original, and asserts nothing was lost and nothing INVENTED. That is the right
 * question about the surgery and the wrong one the moment the schema legitimately moves on: a
 * genuinely new migration is, to that comparison, an invention. So post-split work is exempted
 * — and HOW it is exempted turned out to matter.
 *
 * THE FIRST ATTEMPT EXEMPTED WHOLE FILES BY TAG, AND AN INDEPENDENT REVIEW BROKE IT.
 * `new Set(["0021_mailbox_address_unique"])` waves through whatever that file happens to
 * contain, today and for ever. Delete the migration's dedup prelude, the part that resolves
 * pre-existing duplicates — and every test still passes: the tag/count/closure checks are
 * satisfied, `POST_SPLIT_OBJECTS` still finds the index on a fresh database, and no fixture
 * has duplicates to notice the missing prelude. The first live database with a duplicate then
 * fails the index build and takes the deploy with it. Appending destructive DML to the file
 * was equally invisible.
 *
 * So the unit of exemption is a STATEMENT, identified by the sha256 of its normalized text,
 * and the list is checked in BOTH directions below: every hash must still be present (so a
 * deletion fails) and every statement in a post-split file must be listed (so an addition
 * fails). Any edit to 0021 — one character — changes a hash and stops the suite until a human
 * re-reviews it. That is the intended cost.
 */
const POST_SPLIT_STATEMENTS: Readonly<Record<string, readonly string[]>> = {
  "0018_invites_confers_verified": [
    // CLOUD — does redeeming this invite prove its holder controls the address? Register's
    // invite path stamps `email_verified_at` only when the consumed row says so: mailed invites
    // keep TRUE (receipt is the proof, and the column DEFAULT preserves every existing row's
    // earned semantics with zero data churn), a user's pairing-token redeem writes FALSE (its
    // redeemer typed the address; nothing was mailed), the first-boot ownerless token's redeem
    // stays TRUE (box control is the proof). The writer decides from the consumed TOKEN row,
    // never from caller input.
    //
    // ONE hash, and a SECOND would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one — and here an UPDATE would
    //    be worse than minting a credential: rewriting existing rows' `confers_verified` is
    //    rewriting which accounts may be BORN VERIFIED, a verification decision smuggled in as
    //    a backfill. The default IS the backfill, deliberately.
    //  · **the DEFAULT was flipped or dropped.** FALSE-by-default would strand every operator
    //    mint that predates its caller learning the parameter; NO default plus NOT NULL breaks
    //    every writer at once. TRUE is load-bearing: the rows that opt out are exactly the ones
    //    whose writer knows it is not mailing.
    //  · **an index was added.** Never a lookup key — the one read has already found its row
    //    by the unique `code_hash`.
    "6d68be444b9f0fb1",   // ALTER TABLE invites ADD COLUMN confers_verified boolean NOT NULL DEFAULT true
  ],
  "0060_refresh_tokens": [
    // MAIL — the rotating-refresh store moves to the shared half (Phase 3): QR device pairing
    // gives the desktop-as-host tier bearer pairs whose refresh families rotate, reuse-detect and
    // family-revoke against the LOCAL store, through the same `session-lifecycle` machinery Cloud
    // runs. Every statement is guarded because the table already exists on every hosted and
    // self-host database (cloud 0000); this migration exists for the desktop databases that lack
    // it, and either journal order converges on one catalog (`journal-split.pg.test.ts` diffs it).
    //
    // THREE hashes, and a FOURTH would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one. Every row in this table is a
    //    live, rotatable credential — an INSERT from a journal file would be minting one, the
    //    refusal 0059 states for `pairing_tokens` verbatim. The other direction is as bad: an
    //    `UPDATE refresh_tokens SET revoked_at = …` would be a mass sign-out taken inside a
    //    schema change where no reviewer looks for one.
    //  · **an index was added.** The UNIQUE on `token_hash` IS the rotation's claim lookup; the
    //    family and session indexes are the revocation sweeps' whole read set. Anything else
    //    means somebody is querying refresh history for a purpose this table does not have.
    //  · **a column was added.** The table is exactly the rotation protocol: whose, which
    //    session, which family, the digest, and the three lifecycle timestamps. In particular
    //    there is deliberately no device column (the session row carries `device_id`) and no
    //    surface column (the surface is a property of the presentation, resolved per rotation —
    //    see `rotateRefresh`'s header).
    //
    // The statements are deliberately NOT byte-identical to cloud 0000's (inline named FKs, no
    // `USING btree`): the permutation oracle exempts by content hash, and a byte-identical copy
    // would read as the legacy statement duplicated rather than as post-split work.
    "f607728896fada00",   // CREATE TABLE refresh_tokens — token_hash UNIQUE, named inline FKs
    "f48e5c69fb1f2ef9",   // refresh_tokens_family_idx  — the family revocation sweep
    "e8f16cb47e4ed8d1",   // refresh_tokens_session_idx — the per-session revocation sweep
  ],
  "0062_storage_accounting": [
    // MAIL — the managed storage cap's accounting: the per-account stored-body byte counter
    // (`account_storage`, with its `>= 0` floor), the `message_bodies.withheld_reason` marker
    // (an at-cap ingest writes headers and no content, and the row must be able to say WHY its
    // text is empty), and the closed-set CHECK behind it. The last hash is the BACKFILL — data,
    // argued on 0061's terms rather than waved: it derives every value from the tables
    // themselves (`SUM(octet_length(...))` joined through `messages`), touches no lifecycle or
    // credential column, and its `ON CONFLICT … DO UPDATE SET bytes = excluded.bytes` is a
    // deliberate RECOMPUTE — the runbook re-runs exactly this statement once after the worker
    // deploy, sweeping the bodies the old worker ingested uncounted between the pre-alias
    // migration and its own restart.
    "c37044c28eb4b960",   // CREATE TABLE account_storage (account_id PK, bytes bigint CHECK >= 0)
    "03503a283d9e5fdb",   // ALTER TABLE message_bodies ADD COLUMN withheld_reason text
    "a227474822e0772e",   // DROP CONSTRAINT IF EXISTS message_bodies_withheld_reason (re-runnable pair)
    "92a4c63675e6e5d8",   // ADD CONSTRAINT message_bodies_withheld_reason CHECK (closed set)
    "52b1d0ac40789530",   // INSERT…SELECT SUM(octet_length…) backfill — recomputing, re-runnable
  ],
  "0063_smtp_size_probe_stamp": [
    // MAIL — the `SIZE` back-fill's durable attempt stamp: WHEN the scheduled pass last dialled a
    // mailbox's submission server and WHAT it heard, so a server that announces nothing is re-asked
    // on a backoff instead of once a day for ever. Two nullable columns and a re-runnable
    // DROP/ADD constraint pair (the closed code set), no backfill, no index.
    //
    // FOUR hashes, and a FIFTH would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one, and here it would be worse
    //    than dishonest: `UPDATE mailboxes SET smtp_size_probed_at = now()` silences the back-fill
    //    for a week over rows it has never dialled — deferring the exact work the columns exist to
    //    make sustainable. NULL means "never asked", which is what every existing row is.
    //  · **the CHECK's member list changed.** That is the privacy boundary (the code is derived
    //    from an SMTP AUTH failure, whose message is a third party's response line), so a widened
    //    set has to be read against `SMTP_SIZE_PROBE_CODES` in `packages/db/src/mailbox-errors.ts`
    //    — and a set widened to free text would be the `error_detail` incident again.
    //  · **an index was added.** The selection scans a table with one row per connected mailbox and
    //    orders by `random()`, which forbids an index-ordered read anyway.
    "617617d580d59587",   // ALTER TABLE mailboxes ADD COLUMN smtp_size_probed_at timestamptz
    "fab746947dc4de14",   // ALTER TABLE mailboxes ADD COLUMN smtp_size_probe_code text
    "fb97f9ba7b7e71df",   // DROP CONSTRAINT IF EXISTS mailboxes_smtp_size_probe_code_closed (pair)
    "96853cdd4e0343f6",   // ADD CONSTRAINT mailboxes_smtp_size_probe_code_closed CHECK (closed set)
  ],
  "0061_web_sessions_deviceless": [
    // MAIL — plain browser sign-ins stop owning device rows (DEVICES): `establish` no longer
    // mints a "Web" `devices` row per sign-in, so `device_id IS NULL` means "not a named
    // device" on every tier, and this backfill makes HISTORY match the new writer. The two
    // statements are DATA, which 0060's own entry calls the thing that must never appear — so
    // the exemption is argued, not waved: the UPDATE moves display/aim-scoping metadata ONLY
    // (`device_id`), touching no credential and no lifecycle column — nothing is revoked,
    // nothing expires differently — and the rows it detaches are selected structurally twice
    // over: the auto-mint literal (`kind='web' AND label='Web'`; a pairing mint's label falls
    // back to 'Paired device', never ''), and the surface arithmetic
    // (`refresh_expires_at - last_seen_at < 100 days`: the two columns are written in lockstep
    // by `establish`/`mintRotation`, so their difference IS the mint surface's window — 90d
    // cookie vs 400d native — and a paired device someone labeled "Web" is excluded by its own
    // arithmetic). The DELETE takes only rows no session references (NOT EXISTS, with the FK
    // as the second fence). Both idempotent, deliberately: the runbook re-runs them by hand
    // after the new code is aliased, sweeping the old code's last-minute mints.
    //
    // A THIRD hash would mean a statement was appended — and after this entry, "the last data
    // migration was argued" is not an argument the NEXT one inherits: it needs its own.
    "abdcb8871abf00c3",   // UPDATE sessions SET device_id = NULL — auto-"Web" rows, cookie window only
    "99f4ff92e6fd35f4",   // DELETE FROM devices — the now-unreferenced auto-"Web" rows
  ],
  "0059_pairing_tokens": [
    // MAIL — the pairing-token lifecycle: the standalone server's first-account setup
    // token, family invites, QR device pairing. Mail-half because a token is redeemed against
    // the server that will serve the resulting session and the desktop-as-host arm runs the
    // mail journal only; it names no private table, so the seam holds.
    //
    // THREE hashes, and a FOURTH would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one. Every row in this table is
    //    a live, spendable credential — an INSERT from a journal file would be minting one, the
    //    same refusal 0016 and 0017 state for their credential-shaped rows.
    //  · **an index was added.** The UNIQUE on `token_hash` IS the redeem's lookup; the list
    //    read is per-creator over a handful of rows (0058's no-index rule). A new index means
    //    somebody is querying pairing tokens for a purpose this table does not have.
    //  · **a column was added.** The table is exactly Ruling 1b's census — who minted it, what
    //    redeeming buys, the digest, the label, and the invite lifecycle's four timestamps. In
    //    particular there is deliberately no account column (the creator carries the account;
    //    the first-boot token has neither) and no attempt counter (entropy is the defense on
    //    redeem — a lockout keyed on anything an anonymous caller chooses is a DoS lever).
    "12211b6f4deef828",   // CREATE TABLE pairing_tokens (token_hash UNIQUE; the login_tokens discipline)
    "954831dc4c70fc50",   // CHECK: grant IN ('invite','device-pair') — the closed set, guarded re-runnable
    "2d868862cb61f59f",   // FK created_by_user_id → users.id (nullable: the first-boot mint), re-runnable
  ],
  "0017_oauth_code_twofa_provenance": [
    // CLOUD — the authorizing session's real `last_twofa_at`, carried across the native PKCE hop
    // (SEC3-AUTH-6). `GET /oauth/authorize` mints a code from a browser session; the exchange at
    // `POST /oauth/token` establishes a 400-day native session and asserts no factor of its own.
    // `establish` used to stamp `last_twofa_at = now()` there, which is a timestamp for something
    // that did not happen in that ceremony; this column is the channel that carries the real one.
    //
    // ONE hash, and a SECOND would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one. Every row in this table is a
    //    live authorization code with a sixty-second TTL, so a migration that INSERTed one would
    //    be minting a credential from a journal file.
    //  · **a NOT NULL or a DEFAULT was added.** Both would be wrong, and in the same direction:
    //    NULL is a real state here — "no factor time to inherit" — and it resolves to a session
    //    that cannot clear step-up. A default would manufacture the exact timestamp the column
    //    exists to stop being manufactured.
    //  · **an index was added.** This column is never a lookup key. The single read is the
    //    exchange's, which has already found its row by `code_hash` and narrowed to one.
    //
    // No `ALTER TABLE` on a shared object: `oauth_auth_codes` is a private cloud table. That is
    // load-bearing rather than incidental — the provenance rides on the CODE row precisely so it
    // does not become a `parent_family_id` column on `sessions`, which is SHARED and where the
    // concept has no meaning for a local install with no accounts and no factors.
    "bd5050cf06251ef3",   // oauth_auth_codes.twofa_at — nullable, no default, no index
  ],
  "0015_attachment_staging": [
    // CLOUD — the row half of the hosted send's direct-upload transport. Attachment bytes used to
    // ride the send request base64-encoded, which bound the feature to the serverless body limit
    // and made the compose surface promise 3 MB whatever the sender's own server announced; they
    // now go to object storage on a signed URL and the send carries a reference to a row here.
    //
    // FOUR hashes, and a FIFTH would mean one of three things, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There is none, and there must not be: every row here
    //    names an object in a bucket, so a migration that INSERTed one would be a ticket pointing
    //    at bytes no upload ever wrote — invisible until a send resolved it and refused.
    //  · **a column was added.** The table is deliberately minimal; in particular there is no
    //    `consumed_at`, because a send does not consume a ticket (a retry under the same
    //    `Idempotency-Key` must find the same bytes). Adding one would change what ends a row's
    //    life from RETENTION to consumption, which is the sweep's whole premise.
    //  · **an index was added.** Three is exactly the read set: the unique object path (the sweep's
    //    delete key — two rows naming one object turn one ticket's expiry into another's missing
    //    file), the account index (every read is `WHERE account_id = $1 AND id = ANY($2)`), and the
    //    expiry index (the sweep's whole predicate).
    //
    // No `ALTER TABLE` on a shared object: the FK to `accounts` is a REFERENCE, which is the legal
    // CLOUD → MAIL direction, and nothing here performs DDL on `accounts` itself.
    "c37c387346b059c2",   // attachment_staging — the table, FK to accounts, no consumed_at
    "478b4f9dddaf5822",   // attachment_staging_object_path_unique — the DELETE KEY
    "73534e55efee730f",   // attachment_staging_account_idx — every read is account-scoped
    "ccebb4e2e78dc5ed",   // attachment_staging_expires_idx — the sweep's predicate
  ],
  "0058_reconcile_backoff": [
    // THE RECONCILER'S BOUNDED RETRY — `attempts` and `next_attempt_at` on BOTH desired-state
    // tables, so a mutation the mail server refuses can be deferred instead of retried on every
    // cycle for ever. No index (the pending queries are already bounded by one mailbox's pending
    // set), no CHECK (an instant closes no set and `attempts` is a count), no constraint, nothing
    // dropped or renamed.
    //
    // FOUR hashes, two per table, and the SYMMETRY is the assertion: `flag_state` exists because
    // read-state is `folder_state`'s problem one flag over, and the pass behind it was the one
    // that failed the whole cycle on a refusal rather than isolating it. A version of this
    // migration that gave the columns only to `folder_state` would leave the refused `\Seen`
    // retrying every cycle with nowhere to record that it had been refused before — so a third
    // hash here, or a fifth, stops the suite.
    //
    // The ABSENCE of a data statement is the rest of it. Both defaults ARE the truth for every
    // existing row — zero refusals, due now — so unlike the four migrations below there is no
    // seed anyone could be tempted to write: a backfill could only ever write the values the
    // defaults already produce. The refused statement in the other direction is any
    // `UPDATE folder_state SET next_attempt_at = …` used to "spread the queue out" on deploy,
    // which would put mail the user filed before the deploy to sleep for a reason that has
    // nothing to do with any server having refused it.
    "da2ba15a30b25338",   // folder_state.attempts         integer NOT NULL DEFAULT 0
    "8ed7358be98e5c4e",   // folder_state.next_attempt_at  timestamptz (NULL ⇒ due now)
    "3b11a727b6acaa1a",   // flag_state.attempts           integer NOT NULL DEFAULT 0
    "4813b28ed8cec25a",   // flag_state.next_attempt_at    timestamptz (NULL ⇒ due now)
  ],
  "0057_message_from_name": [
    // WHO A MESSAGE IS FROM, AS THE SENDER WROTE IT — one additive nullable text column on
    // `messages`, the display-name half of the From header the parser has produced since day
    // one and ingest had no column to keep. No default, no NOT NULL, no CHECK (a sender-chosen
    // display name closes no set), no index (projected off rows already fetched; never a
    // predicate).
    //
    // ONE hash, and the ABSENCE of a data statement is the assertion, on 0056's argument with
    // the sign reversed once more: the refused statement here is any
    // `UPDATE messages SET from_name = …` backfill. It is refused not because a value would be
    // false but because the true values are derivable only by RE-PARSING each message's stored
    // headers — real per-row work with its own delta-contract obligations (every touched row
    // owes a `change_log` update or no client mirror ever re-reads it), which a migration can
    // neither page, pace, nor emit. That pass is a deliberate worker one-off, run against a
    // named database, inspectable before it writes. A second statement here stops the suite.
    "02522e1469b2e37e",   // messages.from_name  text (nullable, NO backfill)
  ],
  "0056_screening_baseline": [
    // WHEN THIS ACCOUNT FINISHED SCREENING ITS BACKLOG — one additive nullable timestamptz on
    // `account_settings`, the instant the dormancy window is measured back from instead of from
    // `now()`. No default, no NOT NULL, no CHECK, no index.
    //
    // ONE hash, and the ABSENCE of a data statement is again the assertion — with a third distinct
    // sign, so it is worth stating rather than borrowing from 0055 above. There, both a small and a
    // large seed were wrong because the column means "the SERVER said so". Here the refused
    // statement is `UPDATE account_settings SET screening_baseline_at = now()`, and what makes it
    // wrong is not that the value would be false: for an account that has genuinely finished
    // screening, `now()` is exactly what the one-off runner writes and exactly what the first
    // decide would write. It is wrong because it would run for EVERY account on deploy, including
    // ones mid-way through their first pass, and a baseline is the one value on this row that
    // silently re-partitions a live mailbox — every undecided sender whose newest mail predates the
    // cutoff leaves the Screener queue for History in the same instant, with no user action behind
    // it and no event anywhere saying so.
    //
    // That is the whole reason the backfill is `scripts/backfill-screening-baseline.mjs` and not a
    // second statement in this file: the runner takes a WHERE clause (an account already holding
    // `provenance = 'promoted'` rules, i.e. one that has demonstrably decided at least once), it is
    // run deliberately against a named database, and it can be inspected before it writes. A
    // migration is none of those things. A second statement here stops the suite instead.
    "6f013b24d377db66",   // account_settings.screening_baseline_at  timestamptz (nullable, NO backfill)
  ],
  "0055_mailbox_smtp_max_size": [
    // WHAT THE SENDING SERVER SAID IT WILL ACCEPT — the RFC 1870 `SIZE` announcement the
    // connect-time SMTP probe reads out of its own EHLO, stored per mailbox. ONE additive
    // nullable `bigint` on `mailboxes`: no default, no NOT NULL, no CHECK, no index.
    //
    // ONE hash, and the ABSENCE of a data statement is the assertion — with a sign this census has
    // not seen before, so it is worth stating rather than borrowing from 0047 or 0048. Both
    // refusals there were about a number that would have been either invented or stale-but-true.
    // Here BOTH directions are wrong and they fail differently:
    //
    //  · `UPDATE mailboxes SET smtp_max_size_bytes = 3145728` seeds the product's own constant and
    //    looks harmless because it is the number the send path already enforces. It is not: this
    //    column means "the SERVER said so", so the statement converts a fallback the code can
    //    recognise as ABSENT into a stored fact it cannot, and pins every mailbox on a generous
    //    provider to our constant with nothing to distinguish that from a provider that genuinely
    //    caps at 3 MB.
    //  · `UPDATE mailboxes SET smtp_max_size_bytes = 35882577` (a large real-world value, to
    //    "unblock" desktop sends) asserts a ceiling on behalf of servers that never stated one, and
    //    its failure mode is a BOUNCE rather than a refusal — the direction the column exists to
    //    avoid, since an unknown limit read as no limit costs the user a message they waited for.
    //
    // NULL is the truth about every row here today, and the send path resolves it to the strict
    // fallback. A second statement in this file stops the suite instead of shipping either UPDATE.
    "0f5c493be4f73d00",   // mailboxes.smtp_max_size_bytes  bigint (nullable, no default, NO backfill)
  ],
  "0054_auto_unsubscribe_optout": [
    // THE SWITCH FOR AUTO-UNSUBSCRIBE — one nullable timestamptz on `account_settings`, storing
    // the OPT-OUT. NULL means a screen-out still hands its mail to the one-click path; NOT NULL
    // means this account asked it to stop.
    //
    // ONE hash, and the ABSENCE of a backfill is again the whole assertion — but the reasoning is
    // 0048's with the sign that matters, so it is worth stating rather than borrowing. There, a
    // backfill would have been TRUE about every account and would still have frozen them on the
    // old default. Here `UPDATE account_settings SET block_auto_unsubscribe_at = now()` would be
    // true about NOBODY: not one account has asked for this, and the statement would turn a
    // shipping behaviour off for all of them inside a migration that is meant to add a control.
    // The opposite statement is the one to watch for as well — an opt-IN column plus a backfill
    // that seeds it — because that pair reaches the same place by a longer route.
    //
    // No CHECK (a timestamp closes no set) and no index (the column is read off a row already
    // fetched by primary key and is never a predicate), so a second statement here stops the
    // suite instead of shipping either.
    "8466ba4d0791d2ec",   // account_settings.block_auto_unsubscribe_at  timestamptz (nullable, no default, NO backfill)
  ],
  "0010_desktop_link_pkce": [
    // Binding a desktop handoff code to the process that asked for it: ONE nullable `text` on
    // `login_tokens`, holding the PKCE commitment a code was minted against.
    //
    // Read against the file's own prose before blessing. Three properties are what make one
    // statement the right size for this change, and each is the reason a fourth would be wrong:
    //
    //  · NULLABLE WITH NO BACKFILL, and NULL is a real state rather than an unfilled one — it
    //    means "minted without a commitment", i.e. the retype flow, which is every row in this
    //    table today and every row a browser-only visitor will ever write. `UPDATE login_tokens
    //    SET challenge_hash = …` is the statement that must never appear here: there is nothing
    //    to backfill FROM (a challenge is the digest of a secret held in a process on somebody
    //    else's machine) and writing one would claim a binding nobody can satisfy.
    //  · NOT NOT-NULL, for the same reason — a NOT NULL column would make the unbound flow
    //    unrepresentable, which is the flow that has shipped all along.
    //  · NO INDEX. The column is never a lookup key: the one query that reads it is the claim's
    //    single guarded UPDATE, already narrowed to one row by `login_tokens_token_idx`. An
    //    index would be written on every insert and read by nothing.
    //
    // ONE hash, so appending a second statement — a backfill, a NOT NULL tightening, an index —
    // stops the suite until somebody reads it.
    "7a80ad6fe51f9990",   // ALTER TABLE login_tokens ADD COLUMN IF NOT EXISTS challenge_hash text
  ],
  "0053_account_locale": [
    // THE INTERFACE LANGUAGE — one nullable `text` on `account_settings`, plus the closed-set
    // CHECK, plus the guarded DROP that lets a replay re-run the CHECK without a 42710 (the 0037
    // trap, and the shape 0050 and 0052 use one table over).
    //
    // NO BACKFILL, and the refusal is the same one `0035_account_settings` states about the
    // dormancy dial with a sharper edge. `UPDATE account_settings SET locale = 'en'` is the
    // statement that must never appear here: NULL means "nobody has chosen", and that is what
    // lets an account preference OVERRIDE a device's remembered language while an account with
    // no preference LEAVES the device alone. Writing 'en' for every existing account would
    // collapse those two states into one and would actively reset a German-set browser to
    // English on the next boot — a migration that changes what people see, to say something
    // nobody said.
    //
    // No index. The column is read once per `GET /consent`, on a row already fetched by primary
    // key, and it is never a predicate.
    //
    // THREE hashes, so appending a fourth statement stops the suite.
    "ce25dd93622e5b89",   // account_settings.locale  text (nullable, no default, NO backfill)
    "55ec48dd0cf3f67e",   // drop  CHECK account_settings_locale_supported (re-runnable)
    "c5833f9213f10372",   // CHECK: locale IS NULL OR locale IN ('en','de') — the closed set
  ],
  "0052_rule_body_contains": [
    // A THIRD TERM ON A SENDER RULE — `rules.body_contains`, the 0050 conjunction one field
    // deeper, for the sender whose subjects are all alike ("Notification", "Alert") and whose
    // distinguishing text is in the body. Same shape as 0050 statement for statement: one
    // additive nullable text column, a guarded DROP so a replay does not 42710, and the CHECK.
    //
    // THREE hashes, and 0050's refusal holds one field deeper: no
    // `UPDATE rules SET body_contains = …`, ever — a back-filled term NARROWS a decision the
    // user made about a whole sender, destructively and beyond correction by a later entry.
    //
    // The CHECK's predicate is 0050's regex VERBATIM (`~ '[^ \t\n\r\f\v]'`), not re-derived:
    // one-argument `btrim` trims spaces only, and 0050 measured that against real Postgres so
    // this file does not have to re-learn it. The pg test pins the two constraints' definitions
    // equal up to the column name. For a body term the stake is a notch higher than 0050's —
    // a blank value read as a term matches EVERY MESSAGE, not every subject, because every
    // message has a body to substring.
    "bf1b76dc818f639e",   // rules.body_contains  text (nullable, no default, NO backfill)
    "4fd9ba1f49bcf036",   // drop CHECK rules_body_contains_nonempty  (re-runnable)
    "4bfc62a6ef926a83",   // CHECK: NULL, or a non-blank value of at most 200 chars
  ],
  "0050_rule_subject_contains": [
    // A SECOND TERM ON A SENDER RULE — `rules.subject_contains`, so `info@` at a small host can
    // send the invoice to Receipts and the nightly `[NinjaFirewall]` alert to Reads. One additive
    // nullable text column, plus a CHECK added under a guarded DROP so a replay does not raise
    // 42710 on the constraint (the 0037 trap).
    //
    // THREE hashes, and the statement that must never join them is any
    // `UPDATE rules SET subject_contains = …`. Every backfill this census has refused so far was
    // refused for inventing data; this one would be worse. A term back-filled onto an existing
    // rule NARROWS it — mail that has filed correctly for months stops matching and drifts back
    // to the Ohbox — and by the README's rule about corrective migrations no later entry could
    // undo it for a database that has not yet applied it.
    //
    // The CHECK is load-bearing rather than decorative: it makes NULL the only representation of
    // "no subject term". `''` and a blank string would otherwise be two more, each of which every
    // reader — the router, the adapter's `ORDER BY`, the specificity rank, the client's rule list —
    // would have to classify independently, and the first disagreement is a rule that matches every
    // subject while its row looks specific.
    //
    // Its predicate is a REGEX and not `btrim`, and that is worth reading rather than skimming: the
    // first draft used `length(btrim(subject_contains))`, one-argument `btrim` trims SPACES ONLY, and
    // a tab-only term therefore passed the constraint while the evaluator read the same value as
    // absent — the disagreement the constraint exists to prevent, inside the constraint. Measured
    // against real Postgres, not reasoned about. If this hash changes, that is the paragraph to
    // re-read first.
    "a3520241f0c213d3",   // rules.subject_contains  text (nullable, no default, NO backfill)
    "da081359c78c3cf3",   // drop CHECK rules_subject_contains_nonempty  (re-runnable)
    "9861a9442c2d77b3",   // CHECK: NULL, or a non-blank value of at most 200 chars
  ],
  "0049_mailbox_sync_requested_at": [
    // ENFORCED SYNC — the doorbell the API rings when it finalizes a write the user is looking at,
    // so a sent message's own copy does not wait up to a poll interval to appear. ONE additive
    // nullable timestamptz on `mailboxes`: no default, no NOT NULL, no CHECK, no index.
    //
    // PAID ONE MIGRATION LATE, and recorded rather than quietly bumped. `0049` landed with NONE of
    // the boundary duties except the journal entry itself — not the census here, not the mail entry
    // count below, not `baseline-adoption.test.ts`'s frozen list, not
    // `search-extensions.pg.test.ts`'s `MAIL_ENTRIES`, and not the `/health` marker its own file
    // says it takes (*"`MailboxService.list` selects whole rows, so `["mailboxes",
    // "sync_requested_at"]` joins the mail schema markers"*). Six gates were red on the default
    // branch, which is worse than the `0045`–`0047` lateness the note under the entry count
    // records, because that one at least had the markers. The gates worked; nobody read them.
    // `0049` is blessed here because its single statement is the one named below and its file's own
    // prose is accurate about it — read, not assumed.
    //
    // ONE hash, and the ABSENCE of a data statement is the assertion. `UPDATE mailboxes SET
    // sync_requested_at = now()` would ring the doorbell for every mailbox in the database at
    // once, which is a thundering herd rather than a correctness failure — but it is also
    // meaningless: the stamp means "a user-visible write just landed", and no such write did.
    "e5f05a2e789cf6da",   // mailboxes.sync_requested_at  timestamptz (nullable, no default, NO backfill)
  ],
  "0021_mailbox_address_unique": [
    // The dedup prelude: rank duplicates, disable the losers, delete their credentials.
    "163a932a1e343cee",
    // The drop in front of the index, so the skip window can re-execute this entry. It is NOT
    // `IF NOT EXISTS`: that would KEEP a wrong index of the same name, which is the failure the
    // file's own note argues against. See `DROPPED_INDEX_OWNER` above.
    "6c3d54700e25089c",
    // The partial unique index itself.
    "b6c2729dbab8e1d1",
  ],
  "0022_message_body_html_cap": [
    // The 256 KiB CHECK on `message_bodies.html` — the tripwire for the 2026-08-01 storage
    // outage. Carries NO backfill: discarding the synced mailbox was authorised instead,
    // and every database that runs this journal was verified to hold zero over-cap rows.
    // The drop in front of the CHECK, so the skip window can re-execute this entry; the pair
    // leaves exactly the constraint below behind.
    "c4014c9739d23107",
    "8dadb1da38d0ac8f",
  ],
  "0023_mailbox_failure_reason": [
    // WHY a mailbox failed, not merely THAT it did. Four additive columns, no backfill and no
    // data statement — the existing rows are correct as NULL, which reads as "not recorded".
    // Four hashes and not one, so appending a fifth statement (a backfill, a DELETE) to this
    // file stops the suite instead of shipping silently.
    "f1a28acfccae514b",   // error_code   text
    "4d9dc652acee7f87",   // error_detail text
    "2796c20509d1b273",   // failed_at    timestamptz
    "a54fff1421572451",   // retry_count  integer NOT NULL DEFAULT 0
  ],
  "0024_flag_state": [
    // The read-state desired-state table — `folder_state` for the `\Seen` flag. A new
    // TABLE, so no backfill and no data statement: an absent row means "nobody has expressed an
    // intent about this message", which is the truth for every message ingested before it.
    "23eeb556a6dbe89a",   // CREATE TABLE flag_state (+ the unique on message_id)
    "0bb32ff7250f5bfb",   // the FK to messages(id)
  ],
  "0025_mailbox_kickstart": [
    // The once-per-mailbox HEY-shaping marker. ONE additive nullable column and no
    // backfill: NULL means "never kickstarted", which is the truth for every mailbox connected
    // before this deploy and is exactly what makes their next attach shape them.
    "05334688d345a898",   // mailboxes.kickstart_at  timestamptz NULL
  ],
  "0026_thread_resolution": [
    // Threading at ingest. Two indexes and one additive nullable column, no backfill
    // in SQL — the DATA backfill is `apps/worker/src/thread-backfill.ts`, deliberately in code
    // rather than here, because it re-parses persisted headers and writes `change_log` rows a
    // migration has no way to allocate a per-account seq for.
    //
    // Three hashes and not one, so appending a fourth statement to this file — an UPDATE, a
    // DELETE, a widening of either index — stops the suite instead of shipping silently.
    "7d2f180cf8627901",   // messages(account_id, message_id_header)         — the parent lookup
    "e2cc1cd7919fbb18",   // threads.root_message_id_header  text NULL       — the anchor
    "1919e02d1550d2fd",   // threads(account_id, root_message_id_header) UQ  — the ON CONFLICT key
  ],
  "0027_organizer_lease": [
    // The two columns the organizer lease needs and the CHECK that
    // closes the reason set. No backfill and no data statement, deliberately: every mailbox that
    // exists today was added through a connect flow that does not stamp `takeover_authorized_at`
    // yet, so writing a timestamp would be inventing a record of an action nobody performed.
    //
    // Three hashes and not one, so appending a fourth statement to this file — a backfill, a
    // widening of the CHECK, an UPDATE that stands a mailbox down — stops the suite instead of
    // shipping silently. The CHECK's hash covers its MEMBER LIST: adding a fourth reason to it
    // changes the hash and forces a human back through `MAILBOX_DISABLED_REASONS`.
    "9f9aa2037e7bd5da",   // mailboxes.disabled_reason        text NULL
    "f4b1fad87bea8483",   // mailboxes.takeover_authorized_at timestamptz NULL
    "4cde34882c385f05",   // mailboxes_disabled_reason_closed CHECK — the three organizer kinds
  ],
  "0028_message_instances": [
    // PHYSICAL identity. Eight hashes, and the count is the guard: this is the only
    // post-split migration carrying a DATA statement, so an appended UPDATE or DELETE hiding behind
    // "it already has an INSERT" is exactly what this list refuses.
    "f2c8f6d105639faf",   // CREATE TABLE message_instances (+ the locator unique)
    "2ca6f5ab18f0fe24",   // FK to mailboxes(id)
    "594d234b02d46968",   // FK to messages(id)
    // The PARTIAL unique. Its hash covers the `WHERE "is_primary"` predicate, which IS the
    // assertion: drop the predicate and the index refuses the second instance the table exists to
    // hold; drop the index and two rows can both claim to be a message's primary, so
    // `native_locator` and the instance table can disagree about where a message is.
    "1e10cf6ca152dbef",   // message_instances_primary_uq  UNIQUE (message_id) WHERE is_primary
    "42ea676fda719b64",   // message_instances_message_idx (message_id)
    "52a971a148284f27",   // attachments.content_sha256  text NULL — no backfill; the bytes are gone
    "2420a685cece498b",   // messages.auth_verdict       text NULL — slice 3's column, unwritten
    // THE ONE DATA STATEMENT IN THE WHOLE POST-SPLIT HISTORY, and it is safe for one reason:
    // it COPIES `native_locator` verbatim and computes nothing. A fingerprint backfill would
    // compute — and would compute a different answer than ingest does — which is why the ruling
    // prohibits one and why this hash must be re-reviewed if a character of it ever changes.
    "c989ea6db66b3b9a",   // INSERT … SELECT … WHERE native_locator IS NOT NULL, is_primary = true
  ],
  "0029_mailbox_sync_block": [
    // WHY a `connected` mailbox is not being synced — the other half of the 2026-08-03 incident,
    // where the worker knew for 32 minutes and wrote it only to a log. Two additive nullable
    // columns and the CHECK that closes the reason set. NO backfill and no data statement,
    // deliberately: NULL is the true state of every existing row, and inventing a block for a
    // mailbox that is syncing fine is the opposite of this migration's point.
    //
    // Three hashes and not one, so appending a fourth statement — a backfill, an UPDATE that stamps
    // a reason, a widening of the CHECK — stops the suite instead of shipping silently. The CHECK's
    // hash covers its MEMBER LIST, so adding a fourth reason forces a human back through
    // `MAILBOX_SYNC_BLOCK_REASONS` and its "there is no `no_organizer` member" note.
    "cb9cb788be3606db",   // mailboxes.sync_blocked_reason  text NULL
    "b34fa812d1566547",   // mailboxes.sync_blocked_since   timestamptz NULL
    "a7f29ce05a08e3a0",   // mailboxes_sync_blocked_reason_closed CHECK — the three infra refusals
  ],
  "0030_sensitive_rescreen": [
    // The marker for the one-time re-evaluation of mail that `pipeline.ts:393`'s sensitivity
    // override had already misrouted into the Ohbox. ONE additive nullable column, no
    // backfill and NO DATA STATEMENT — and the absence is the point worth pinning, not an
    // omission. This migration's whole subject is a correction to already-stored mail, so a
    // reader looks for the correction IN it; the decision is `evaluateRules` (the user's rules,
    // their contacts, a header heuristic) and SQL cannot re-implement that without becoming a
    // second router that drifts from the first. ONE hash, so appending an `UPDATE folder_state`
    // to this file stops the suite instead of shipping a migration that re-files somebody's mail
    // by a rule nobody reviewed.
    "f008077010f42e02",   // mailboxes.sensitive_rescreen_at  timestamptz NULL
  ],
  "0031_tags": [
    // TAGS — the account's own labels, keyed by message and NEVER an IMAP folder. Two new
    // tables, their two foreign keys, the case-insensitive name unique and the two lookup indexes.
    // Purely additive: no ALTER on an existing table, no backfill, and NO DATA STATEMENT.
    //
    // SEVEN hashes and not one, because the shape of this migration is the argument for it. The
    // `lower(name)` unique is what makes "Invoices" and "invoices" one tag, and the PK on
    // `(message_id, tag_id)` is what makes a double-assign a no-op instead of a duplicate chip —
    // both are load-bearing for `TagsService`, so weakening either one has to stop the suite
    // rather than ship. Appending an eighth statement — a cascade, a backfill that invents tags
    // from folder names — fails here first, which is the point: a tag that came from an IMAP
    // folder would contradict the one invariant this whole slice is built on.
    "003f9a2fed9971d1",   // CREATE TABLE tags
    "5a32008220e7383b",   // CREATE TABLE message_tags (PK message_id, tag_id)
    "4e17c00838e2a21a",   // FK message_tags.message_id -> messages.id   (ON DELETE no action)
    "47398370e04d634f",   // FK message_tags.tag_id     -> tags.id       (ON DELETE no action)
    "43d594eac2e15d6c",   // tags_account_name_uq  UNIQUE (account_id, lower(name))
    "8d6f1da3238cb8aa",   // message_tags_account_message_idx  — the materialize lookup
    "5e08e43f8cf6cc31",   // message_tags_tag_idx              — the delete sweep
  ],
  "0032_unsubscribe_records": [
    // AUTO-UNSUBSCRIBE's at-most-once record. One new table, its two foreign keys, the
    // unique index that IS the idempotency key, and one account lookup index. Purely additive:
    // no ALTER on an existing table, and NO DATA STATEMENT.
    //
    // The absence of a data statement is the hash worth having here, more than any of the
    // others. This table's whole purpose is to stop duplicate outbound requests to third
    // parties, and the obvious "helpful" addition to it is a backfill — an INSERT that
    // pre-claims the thousands of senders already screened out, or worse one that seeds them as
    // unsent so the first drain sweeps the lot. Either one is a decision about thousands of
    // requests leaving the building, taken inside a schema change where no reviewer would look
    // for it. FIVE hashes means appending a sixth statement stops the suite instead of shipping.
    //
    // The unique index's hash is the second load-bearing one: `unsubscribe_records_mailbox_list_uq`
    // is not a lookup optimisation, it is the mutual exclusion that makes two concurrent workers
    // send once. Widening it, or dropping `mailbox_id` from it, has to fail here.
    "2e31b85579026cf1",   // CREATE TABLE unsubscribe_records (+ state CHECK, closed)
    "4ad9253337d999e1",   // FK unsubscribe_records.mailbox_id -> mailboxes.id  (ON DELETE no action)
    "75178efc4f65fca8",   // FK unsubscribe_records.message_id -> messages.id   (ON DELETE no action)
    "0458ea8efa4f4403",   // unsubscribe_records_mailbox_list_uq  UNIQUE (mailbox_id, list_key)
    "bba15762002719a4",   // unsubscribe_records_account_idx      — the account-scoped read
  ],
  "0033_workflow_run_claim": [
    // CRASH-RESUME for workflow runs: WHEN the `running` claim was made, so a run stranded
    // by a dead worker becomes findable. ONE additive nullable column and NO DATA STATEMENT —
    // and the single hash is the assertion, because the statement this file must never grow is a
    // backfill.
    //
    // `UPDATE workflow_runs SET claimed_at = created_at WHERE status = 'running'` is the obvious
    // one, it was written, and it is a silent permanent bug. `created_at` is `now()`, stored at
    // MICROSECOND precision; the reaper's guarded requeue re-asserts the stamp it OBSERVED, and
    // that observation has round-tripped through a MILLISECOND-precision JS `Date`. Measured on
    // the :5433 Postgres — `…05.404402+00` stored, `…05.404Z` read back, the equality matched ZERO
    // rows. Every backfilled row would be selected as stale by every pass and requeued by none of
    // them, and no test could go red on it, because no fixture holds production's `created_at`.
    //
    // A second hash appearing here therefore means somebody re-added that statement, or a
    // `DELETE` of stranded runs, or an `UPDATE … SET status='failed'` deciding in SQL what the
    // reaper decides in code. All three have to stop the suite rather than ship.
    "dc488109390010cf",   // claimed_at  timestamptz  (nullable, no default, NO backfill)
  ],
  "0036_sensitive_fp_backfill": [
    // The one-shot marker for repairing bodies a classifier FALSE POSITIVE stored redacted, with
    // their sender HTML discarded. ONE statement, one nullable timestamp on `mailboxes`, and
    // deliberately NO BACKFILL: NULL is the value that means "this mailbox has never been
    // repaired", which is true of every mailbox the moment this lands, and stamping a timestamp
    // on any of them would mark damage as already fixed and make it unreachable for ever.
    //
    // The statements that must never appear beside it are the ones that would do the repair in
    // SQL. There is no `UPDATE messages SET sensitivity_category = NULL`, and there cannot be:
    // clearing a category is only correct for a message the FIXED classifier clears when re-run
    // over the ORIGINAL bytes, and those bytes are on an IMAP server that no migration can read.
    // A blanket clear would un-redact genuine authentication mail — nearly all the categorised
    // bodies on the hosted service stay sensitive under the fixed classifier — so a second hash here is
    // a repair being attempted in the one place that cannot see the evidence for it.
    "b7862f6f290242d7",   // sensitive_fp_backfill_at  timestamptz  (nullable, no default, NO backfill)
  ],
  "0037_draft_html": [
    // The rich half of a draft: one nullable `html` column and the 256 KiB ceiling that
    // mirrors `0022_message_body_html_cap`. Deliberately NO BACKFILL, and the absence is the
    // statement worth pinning rather than the presence of either of these two.
    //
    // The obvious addition is `UPDATE drafts SET html = '<p>' || body || '</p>'`, and it is
    // wrong twice over. It invents a rich draft nobody composed, and it does the inventing
    // with an ESCAPING rule — what happens to a `<` somebody typed into a plain-text draft —
    // chosen inside a schema change, which is the one place no reviewer looks for one. A row
    // with NULL `html` already means "this draft is plain text", which is true of every draft
    // that exists and needs no statement to become true.
    //
    // TWO hashes, so appending a third — a backfill, a DELETE of drafts over the cap, an
    // `ALTER … DROP NOT NULL` on `body` that would let a rich draft exist with no plain-text
    // alternative — stops the suite instead of shipping. The CHECK's hash covers its LITERAL:
    // changing 262144 here changes the hash and forces a human back through 0022's header,
    // where that number is argued, and through `DRAFT_HTML_CAP_BYTES`, which restates it.
    //
    // THE CHECK'S HASH MOVED ONCE, and this is the re-review that costs. It shipped as a bare
    // `ALTER TABLE … ADD CONSTRAINT`, which has no `IF NOT EXISTS`, so replaying the journal
    // raised 42710 and killed the pass — caught by `mailbox-dedup.pg.test.ts`, which rewinds a
    // migrated database and re-migrates it. It is now wrapped in the `duplicate_object` catch
    // 0000, 0009, 0013, 0027 and 0029 use. The CONSTRAINT is byte-for-byte what it was, cap
    // literal included; only the envelope changed, so a database that already applied the bare
    // form is unaffected and a fresh one builds the identical object.
    "338c0f82e098e854",   // drafts.html  text NULL — no backfill
    "0adee1d47ac41176",   // drafts_html_cap CHECK — octet_length(html) <= 262144, in a DO block
  ],
  "0039_mailbox_retry_after": [
    // WHEN the leader may next attach a quarantined mailbox. ONE additive nullable column and no
    // backfill: NULL is "no backoff is in force", which is the true state of every existing row.
    //
    // ONE hash, and the singleness is the assertion. The obvious next statement to append here is
    // an `UPDATE mailboxes SET retry_after = ...` seeding the rows that are currently `error`, and
    // it would be wrong twice: those rows' backoffs are held in a running process that has not
    // been told about them, so a seeded instant would either park a mailbox the worker is about to
    // retry or release one it is not. The worker rewrites the column on its next failure, which is
    // the only source that knows. A second statement in this file stops the suite instead.
    "81aaa4e346c1c358",   // retry_after  timestamptz (nullable, no default, NO backfill)
  ],
  "0040_auto_suggest": [
    // The auto-suggest opt-in. ONE additive nullable column on `account_settings`, no default and
    // no backfill: NULL is OFF, OFF is the default, and every account that has never changed a
    // setting has no row here at all — so there is nothing to backfill and no row to visit.
    //
    // ONE hash, and the singleness is the assertion, because the statement somebody will be
    // tempted to append is an `UPDATE account_settings SET auto_suggest_at = now()` turning the
    // feature on for existing accounts. That would be a migration granting itself permission to
    // spend those accounts' credits — the one thing the flag exists to require an answer for.
    // A second statement in this file stops the suite instead of shipping that.
    //
    // `IF NOT EXISTS` rather than a bare `ADD COLUMN`: replaying the journal is a supported
    // operation (`setup-prod.ts` is idempotent per journal, and `mailbox-dedup.pg.test.ts` rewinds
    // and re-migrates), and the bare form raises a duplicate-column error the second time. An earlier migration's CHECK learned this
    // the expensive way one entry up.
    "44cce2724050b984",   // account_settings.auto_suggest_at  timestamptz (nullable, NO backfill)
  ],
  "0041_message_failures": [
    // The DURABLE per-message failure ledger — the one place the sync design lost mail rather than
    // delaying it. One new table, its foreign key, one partial index. No ALTER on an existing
    // table, and NO DATA STATEMENT.
    //
    // THREE hashes, and the absence of a fourth is the assertion. The statement somebody will be
    // tempted to append is a backfill that pre-claims the UIDs the in-memory ledger has already
    // written off — and there is nothing to backfill FROM: those decisions lived in a process that
    // has exited, and the `audit_log` rows that recorded them carry a UID whose server epoch may
    // since have been renumbered. An INSERT built from them would put rows in this table for
    // locators that either no longer exist or now name a DIFFERENT message, and this table's whole
    // job is to keep a UID out of the known-set — so a wrong row silences real mail. The mail the
    // pre-migration ledger skipped in an ENUMERATED folder is re-offered by the known-set diff on
    // the first cycle after this deploy and needs no row; the mail it skipped in SENT is behind the
    // watermark and is genuinely unrecoverable, which is the loss this migration stops happening
    // AGAIN rather than one it can undo.
    //
    // The CREATE TABLE's hash covers the CHECK's MEMBER LIST, so adding a sixth `code` changes it
    // and forces a human back through `MessageFailureCode` — the same property
    // `mailboxes_sync_blocked_reason_closed` has, and for the same the "Account isolation is absolute, and it binds staff too" invariant reason: nothing a mail
    // server chose may reach a column that is read as a reason.
    //
    // The index's hash covers its `WHERE resolved_at IS NULL` predicate, which IS the assertion:
    // drop the predicate and every cycle walks the whole resolved history of the account.
    "85262b899836905b",   // CREATE TABLE message_failures (+ the locator unique, + the code CHECK)
    "38577bd0d3379f93",   // FK message_failures.mailbox_id -> mailboxes.id  (ON DELETE no action)
    "172843ad587c56db",   // message_failures_due_idx — PARTIAL, `resolved_at IS NULL`
  ],
  "0042_screening_preference": [
    // The editable Ohbox preference (SCR-SPAM/SCR-PROMPT): two additive nullable columns on
    // `account_settings`, each with its CHECK inline on the `ADD COLUMN IF NOT EXISTS`. No default
    // and NO BACKFILL — NULL `ohbox_policy` reads LENIENT (`people_and_replied`), which is the whole
    // of the day-one safety: the demotion arrives only when an account opts in.
    //
    // TWO hashes, and the singleness of each column is the assertion. The statement somebody will be
    // tempted to append is `UPDATE account_settings SET ohbox_policy = 'people_only'` turning the
    // strict posture on for existing accounts — a migration silently reorganising every mailbox,
    // which is exactly what NULL-reads-lenient exists to refuse. A third statement in this file stops
    // the suite instead of shipping that. Each CHECK's hash covers its LITERAL SET / length cap, so
    // widening the policy enum or the 2 KiB bar cap changes the hash and forces a re-review against
    // `OhboxPolicy` and the migration header.
    "5a1f685752f82afa",   // account_settings.ohbox_policy text + CHECK (enum, closed) — NO backfill
    "0002443390a00cd8",   // account_settings.ohbox_bar    text + CHECK (octet_length <= 2048)
  ],
  "0043_ohbox_tidy": [
    // The Ohbox backlog re-route marker (SCR-BACKLOG-REROUTE): three additive nullable columns on
    // `account_settings` and one PARTIAL index on `change_log`. No default and NO BACKFILL — NULL on
    // every existing account means "no tidy asked for, nothing owed", which is the whole of the
    // day-one safety (no mail moves the day this ships).
    //
    // FOUR hashes, and their singleness is the assertion. The statement somebody will be tempted to
    // append is `UPDATE account_settings SET ohbox_tidy_requested_at = now()` — arming the retro pass
    // for every existing account and re-routing their Ohbox on the next worker cycle, the exact
    // silent-reorganisation NULL-is-not-owed exists to refuse. A fifth statement here stops the suite
    // instead of shipping that. The index hash covers its `WHERE op='move' AND meta->>'to'='INBOX'`
    // predicate, which IS the assertion: widen the predicate and the "user always wins" guard scans
    // more than the move-to-Ohbox rows it must.
    "aabc1572b8d9b2c0",   // account_settings.ohbox_tidy_requested_at  timestamptz (nullable, NO backfill)
    "fe964e38952ea0d8",   // account_settings.ohbox_tidy_done_at       timestamptz (nullable, NO backfill)
    "fe449688c7009055",   // account_settings.ohbox_tidy_cursor        uuid        (nullable, NO backfill)
    "3c4dc7f7177c7ae8",   // change_log_move_to_inbox_idx — PARTIAL, `op='move' AND meta->>'to'='INBOX'`
  ],
  "0044_dormancy_days_max": [
    // The one-year ceiling on `account_settings.dormancy_days` (SET-IA). ONE statement, a bare
    // `ADD CONSTRAINT` wrapped in the 0037 `duplicate_object` catch so a journal replay is a no-op.
    // No default and NO BACKFILL — the column has had zero writers since 0035, so the validation scan
    // finds no non-NULL row and there is nothing to repair.
    //
    // ONE hash, and the singleness is the assertion. The statement somebody will be tempted to append
    // is an `UPDATE account_settings SET dormancy_days = LEAST(dormancy_days, 365)` clamping any value
    // that slipped in above the bound — and there is none to clamp (the writer is new and the column
    // was never written), so a second statement in this file would invent a repair for damage that
    // does not exist. The hash covers the CHECK's LITERAL (365), so moving the bound changes it and
    // forces a re-review against 0035's floor and `setDormancyDays`'s restated 1–365 refusal.
    "def1a34e01e90246",   // account_settings_dormancy_days_max CHECK (dormancy_days IS NULL OR <= 365), in a DO block
  ],
  "0045_draft_bcc": [
    // BCC ON A DRAFT. ONE additive jsonb column on `drafts`, the exact twin of `cc`. `NOT NULL
    // DEFAULT '[]'` rather than nullable, so a draft naming no bcc holds `[]` and every reader
    // treats it exactly as it treats an empty `cc` — the default is what makes a backfill
    // unnecessary rather than omitted, since every draft that exists predates bcc and has none.
    //
    // ONE hash, and the singleness is the assertion — with a sharper edge than the other additive
    // columns on this list. The statement somebody will be tempted to append is an `UPDATE drafts
    // SET bcc = ...` lifting addresses out of `cc` or out of a stored header, and it would INVENT a
    // blind copy nobody addressed, on drafts whose authors already decided who could see the
    // recipient list. It is also the one place a reviewer would never look for a recipient change:
    // bcc rides the SMTP ENVELOPE and is deliberately absent from the transmitted headers AND from
    // the Sent-folder copy, so a wrong row here is an extra recipient with no trace in the message
    // the sender can see. A second statement in this file stops the suite instead of shipping that.
    "cb3ed1249cdf21e6",   // drafts.bcc  jsonb NOT NULL DEFAULT '[]' — no backfill
  ],
  "0046_screener_auto_apply": [
    // The SCREENER AUTO-APPLY opt-in — the second per-account flag `0035_account_settings` foresaw,
    // and the twin of `0040_auto_suggest`'s. ONE additive nullable timestamptz on
    // `account_settings`, no default and no backfill: NULL is OFF, OFF is the default, and most
    // accounts have no `account_settings` row at all, so there is nothing to visit.
    //
    // ONE hash, and the singleness is the assertion — for a sharper reason than 0040's. This flag
    // authorises a worker pass to MOVE somebody's held mail out of the Screener with no per-message
    // click, so an appended `UPDATE account_settings SET screener_auto_apply_at = now()` would be a
    // migration granting itself permission to reorganise every existing mailbox on the next worker
    // cycle. That is the same silent-reorganisation shape `0034_rule_retro` and `0043_ohbox_tidy`
    // refuse, and moving mail on somebody's behalf is precisely the act an opt-in exists to require
    // an answer for. A second statement in this file stops the suite instead of shipping it.
    "f678dcdb27c85501",   // account_settings.screener_auto_apply_at  timestamptz (nullable, NO backfill)
  ],
  "0051_away_responder": [
    // THE AWAY RESPONDER'S AUDIENCE, AND THE RECORD THAT MAKES IT REPLY ONCE. Six statements, and
    // the census is worth reading here because this is the first migration on this list whose
    // feature SENDS MAIL in somebody's name.
    //
    // The two that carry the argument are the CHECK and the UNIQUE INDEX. The CHECK closes
    // `audience` to two members, so a value nobody enumerated cannot be stored and then resolved
    // by whichever branch the pass falls through to — and the branch it would fall through to is
    // the WIDER audience. The unique index is not an index for speed: it is the ON CONFLICT target
    // that makes "one reply per sender per enablement" a property of the schema instead of a
    // property of the pass's control flow, so deleting it cannot be done without the guard
    // visibly disappearing.
    //
    // THE STATEMENT THAT MUST NEVER JOIN THIS LIST is an INSERT seeding `away_responder_sent` for
    // mail already on disk. It looks like caution — it would suppress a burst of replies on the
    // first cycle after the deploy — and it is a decision about thousands of correspondents taken
    // inside a schema change where nobody would read it. The pass needs no such seed: it only
    // considers messages ingested after the current episode's floor, so the backlog is not a
    // candidate. `UPDATE away_responders SET audience = 'everyone'` is the other one, and it would
    // widen an audience on behalf of every account that has ever configured a responder.
    //
    // Six hashes, so a seventh statement stops the suite instead of shipping either of those.
    "1407653d8d654c8f",   // away_responders.audience  text NOT NULL DEFAULT 'screened_in'
    "703a0bb65f04e701",   // drop  CHECK away_responders_audience_closed  (re-runnable)
    "c3b3e5e686214b66",   // CHECK: audience in ('screened_in','everyone') — closed, two members
    "ea852b759e7196b0",   // CREATE TABLE away_responder_sent  (no FKs — see the migration header)
    "1f8b9e85cd62fef8",   // away_responder_sent_episode_uq   — THE at-most-once guard
    "b395c305e0396d1f",   // away_responder_sent_account_idx  — the erasure sweep's scan
  ],
  // `0049_mailbox_sync_requested_at`'s entry is ABOVE, beside `0050_rule_subject_contains`. The
  // away-responder slice wrote a second copy of it here — its own census bump could not be paid
  // without accounting for 0049 either — and the two were authored concurrently, so both existed
  // until this merge. A duplicate key in this object is not a harmless redundancy: the later one
  // WINS silently, so two reviews of the same statement would collapse to whichever was written
  // lower in the file. Deleted here rather than there because the surviving copy is the one that
  // landed on `main` and has been read since.
  "0048_remote_images_default": [
    // REMOTE IMAGES BY DEFAULT — and the column stores the OPT-OUT, which is the whole review.
    // `block_remote_images_at` NULL means a message's pictures load (through the proxy, so the
    // sender never learns the reader's address); NOT NULL means this account asked to keep the
    // per-message "Show images" flow. ONE additive nullable timestamptz on `account_settings`,
    // no default, no NOT NULL, no CHECK — a catalog-only change on a table with one row per
    // account.
    //
    // ONE hash, and the ABSENCE of a backfill is again the assertion — but the reasoning is the
    // MIRROR of 0047's, so it is worth stating rather than borrowing. There, a backfill would
    // have invented data. Here, a backfill (`UPDATE account_settings SET block_remote_images_at
    // = now()`) would be perfectly truthful about the past — every existing account HAS been on
    // the manual flow — and it is still refused, because it would freeze every one of them on
    // the OLD default for ever and leave the new default reaching nobody. A default nobody is on
    // is not a default. The opt-out is stored, so the only rows in this column belong to people
    // who deliberately chose otherwise. A second statement here — that backfill, or an index on
    // a column read only by primary key — stops the suite instead.
    "ca662c040a2ca16c",   // account_settings.block_remote_images_at  timestamptz (nullable, no default, NO backfill)
  ],
  "0047_read_order": [
    // READ ORDER — WHEN a message stopped being unread, so the Ohbox's "Earlier" group is ordered by
    // the reading instead of by the sending. ONE additive nullable timestamptz on `messages`: no
    // default, no NOT NULL and deliberately NO INDEX, so it is a catalog-only change that rewrites
    // no rows and takes no long lock on the largest table in the schema.
    //
    // ONE hash, and the ABSENCE of a backfill is the whole assertion. `UPDATE messages SET
    // last_read_at = updated_at WHERE unread = false` is the obvious statement and it is a lie a
    // reader cannot detect: `updated_at` moves when the reconciler observes the server's own
    // `\Seen`, on retries and on unchanged observations, so it would put a manufactured reading
    // order in front of somebody with no way to tell it from a real one. NULL means "not known" and
    // sorts below every stamped row, which is the honest answer for every message read before this
    // column existed. A second statement here — a backfill, or the index the header argues against
    // — stops the suite instead.
    "1c0fdeb1d2dcf2ca",   // messages.last_read_at  timestamptz (nullable, no default, NO backfill, no index)
  ],
  "0038_initial_import_completed": [
    // WHEN a mailbox's first import actually finished — a per-mailbox floor the client reads
    // as `IS NULL ⇒ still importing`, so a partial mailbox stops presenting itself as complete.
    // ONE additive nullable column, no default and deliberately NO BACKFILL: NULL is the true
    // state of every existing row, and stamping `now()` onto a mailbox still mid-backfill would
    // assert its import was done while a hole was still on screen — the exact defect this column
    // removes. ONE hash, so appending an `UPDATE mailboxes SET initial_import_completed_at = …`
    // stops the suite instead of shipping a claim that every existing mailbox is finished.
    "8a15b219ce45c10a",   // initial_import_completed_at  timestamptz (nullable, no default, NO backfill)
  ],
  "0035_account_settings": [
    // The first per-account settings row: the dormancy cutline dial, and the record that the
    // sent-mail seed review was confirmed. ONE statement, a CREATE TABLE, and deliberately NO
    // BACKFILL — an absent row means "this account has never changed anything", which is the
    // truth for every account that exists today and is what every reader is required to assume.
    //
    // A backfill is the statement that must never appear here. Writing a row per account would
    // freeze each of them at whatever the default dial happened to be on the day of the deploy,
    // which is precisely the difference between a dial and a constant.
    "15ac202a4b51c792",   // CREATE TABLE account_settings (+ the dormancy_days CHECK)
  ],
  "0034_rule_retro": [
    // a rule the user creates is now APPLIED to mail already on the server, by the
    // worker's `ruleRetroPass`. Four additive nullable-or-defaulted columns carrying the request,
    // the completion marker, the resume cursor and a counter — and, deliberately, NO DATA
    // STATEMENT.
    //
    // `UPDATE rules SET retro_requested_at = now()` is the obvious one and it is the one that
    // must never appear. Every rule that exists today was created under a contract where writing
    // a rule moved no mail; back-dating the request would hand the worker the entire stored
    // history of every account at once and reorganize mailboxes on the strength of decisions
    // their owners made about the FUTURE. Four rules on a live account are in that set.
    // Seven hashes and not one, so appending an eighth statement stops the suite.
    "567f9026c36ec5b3",   // retro_requested_at  timestamptz
    "688c7c8972431ace",   // retro_done_at       timestamptz
    "aa69da2d246a0744",   // retro_cursor        uuid
    "d6a131b7a388bc2e",   // retro_moved         integer default 0 not null
    "386dae4fa4c27325",   // rules_retro_owed_idx            — the PARTIAL owed-work probe
    "0d2d4f9e108797b7",   // messages_account_from_addr_idx  — the sender scope; there was NO
                          //                                   index on from_address before this
    "cd32e6c9520200c1",   // messages_account_from_domain_idx — the domain scope, first-@
  ],
  "0064_device_sync_stamp": [
    // Mail 0064 — the per-device sync-horizon stamp the `device_sync_stale` alert reads. One
    // additive nullable column, deliberately no backfill (an unstamped device is one that has
    // not reached its horizon since the column landed, which is the honest state). One hash, so
    // appending a second statement stops the suite.
    "3c84f77ef25a1e1e",   // devices.last_synced_at  timestamptz
  ],
  "0065_junk_trash_delete": [
    // Mail 0065 — the junk+delete plan's persistence: the provider's own \Junk/\Trash paths as
    // discovered at connect, the tombstone stamp, and the widened withheld-reason CHECK
    // (dropped-then-added so a replay is a no-op). Deliberately NO data statement: NULL folder
    // paths mean "not discovered yet" and a NULL deleted_at means nothing was deleted, both true
    // of every existing row. Five hashes, so a sixth statement stops the suite.
    "c2988006d4c97897",   // mailboxes.junk_folder   text
    "f660fdcf9c930bdd",   // mailboxes.trash_folder  text
    "e2b21385d70f5acc",   // messages.deleted_at     timestamptz
    "a227474822e0772e",   // DROP CONSTRAINT message_bodies_withheld_reason (re-runnable half)
    "82887d4fe02cd288",   // ADD  CONSTRAINT message_bodies_withheld_reason (the widened set)
  ],
  "0069_folders_enabled_reissue": [
    // Mail 0069 — 0066's one statement re-run from a fresh journal position (the original
    // entry was skippable on databases that migrated between two lanes' landings;
    // REISSUED_ORIGINALS in src/baseline.ts carries the account). The file is a BYTE COPY of
    // 0066's — so the stored drizzle hash describes both entries — and the SAME normalized
    // statement means the SAME hash here; listed under its own tag so the census names every
    // post-split entry, while the exemption's set semantics already cover both copies.
    "b92a2b025041dd66",   // account_settings.folders_enabled_at  timestamptz (0066's, verbatim)
  ],
  "0066_folders_enabled": [
    // Mail 0066 — "Use folders", the folders foundation's master toggle
    // (account_settings.folders_enabled_at; NULL = off = the pre-feature wire). One additive
    // nullable column and deliberately NO data statement: the feature is opt-in per account and
    // a backfill would be a truthful statement about nobody. One hash, so a second statement —
    // a backfill, a default — stops the suite.
    "b92a2b025041dd66",   // account_settings.folders_enabled_at  timestamptz
  ],
  "0067_device_sync_health": [
    // Mail 0067 — the device-sync alert's SECURITY DEFINER carrier, WITHDRAWN by 0068 the same
    // night (the staff-role attestation refuses executable secdef routines by construction).
    // Kept because a journal is append-only; the pair nets to nothing. Three hashes.
    "1a820342874a2837",   // CREATE OR REPLACE FUNCTION device_sync_stale_candidates(...)
    "dd9c6a1178c4b6b0",   // REVOKE ALL ... FROM PUBLIC
    "ff2726aa76639bb6",   // guarded GRANT EXECUTE to ohmail_admin
  ],
  "0068_retire_device_sync_fn": [
    // Mail 0068 — retires 0067's function (DROP IF EXISTS, so a database that never applied
    // 0067 drops nothing). One hash.
    "13c855ddeba8633a",   // DROP FUNCTION IF EXISTS device_sync_stale_candidates(...)
  ],
  "0070_session_sync_stamp": [
    // Mail 0070 — the per-SESSION sync-horizon stamp (`sessions.last_synced_at`), 0064's twin
    // one level down, for the DEVICELESS installs the first real staleness incident proved
    // invisible (a browser-door desktop holds a `device_id IS NULL` session — mail 0061 — and
    // was outside the device alert's population by construction). One additive nullable
    // column, deliberately no backfill: NULL means "never completed a drain", which is the
    // honest state of every existing row. One hash, so appending a second statement stops the
    // suite.
    "50e092769dbf0209",   // sessions.last_synced_at  timestamptz
  ],
  "0071_withheld_provenance_index": [
    // Mail 0071 — the husk-provenance partial index: the withheld-body reads that walk by
    // REASON (the worker's `junk_filed` convergence pass via `listJunkFiledHusks`; the future
    // `storage_cap` restore 0062's column comment names) would otherwise test the marker on
    // every body of the mailbox per cycle to find the handful of husks. PARTIAL on the marker
    // being set, so it holds only the husks; the reason leads, `message_id` follows so the
    // pass's keyset rides the index order. One hash, and the singleness is the assertion: the
    // statement somebody will be tempted to append is a backfill that "repairs" husks into
    // ordinary rows — but a husk is POLICY, not damage (0062's rule), and any restore goes
    // through `core/husk-restore.ts`'s verify/rewrite, never through DML in a migration.
    "5642d4b92cc8e249",   // message_bodies_withheld_idx — PARTIAL (withheld_reason, message_id)
  ],
  "0072_tracking_pixels_optout": [
    // TRACKING PIXELS STAY BLOCKED BY DEFAULT — and the column stores the opt-out of that
    // PROTECTION, which is the review. `load_tracking_pixels_at` NULL means a beacon is never
    // fetched (the posture 0048 kept in both images modes); NOT NULL means this account asked for
    // pixels to load along with the pictures, through the same proxy. ONE additive nullable
    // timestamptz on `account_settings`, no default, no NOT NULL, no CHECK — 0048's shape.
    //
    // ONE hash, and the ABSENCE of a backfill is again the assertion, with the sign the other
    // way from 0048's: there, a backfill would have frozen everybody on the OLD default; here, a
    // backfill (`UPDATE account_settings SET load_tracking_pixels_at = now()`) would opt every
    // account OUT of a protection nobody asked to lose. The default is the absence. A second
    // statement here — that backfill, or an index on a column read only by primary key — stops
    // the suite instead.
    "34bbf209673f9674",   // account_settings.load_tracking_pixels_at  timestamptz (nullable, no default, NO backfill)
  ],
  "0073_mailbox_folders_optout": [
    // PER-MAILBOX "USE FOLDERS" STORES THE EXCEPTION — and the sign is the review.
    // `folders_disabled_at` NULL means this mailbox's folders SHOW whenever the account's
    // master flag (0066/0069) is on — the ruling's expectation: enabling folders on a
    // six-mailbox account shows all six trees. NOT NULL is "when this mailbox was switched
    // off". ONE additive nullable timestamptz on `mailboxes`, no default, no NOT NULL, no
    // CHECK, no index — 0066's shape on the mailbox row.
    //
    // ONE hash, and the ABSENCE of a backfill is the assertion, 0072's way round: an UPDATE
    // here (`SET folders_disabled_at = now()`) would switch every existing mailbox OFF under a
    // master flag its account deliberately turned on. Participation is the absence. A second
    // statement — that backfill, or an index on a column only ever read through the
    // `listUserFolders` mailbox join — stops the suite instead.
    "28cad45f2314d836",   // mailboxes.folders_disabled_at  timestamptz (nullable, no default, NO backfill)
  ],
  "0074_folder_ops": [
    // USER-COMMANDED FOLDER OPERATIONS — the stage-2 verbs' command table (create / rename /
    // delete from the rail). The API records the user's command and rings the doorbell; the
    // worker executes the IMAP write inside the mailbox's serial cycle and DELETES the row —
    // `folder_state`'s desired/observed split lifted to the folder tree. ADDITIVE ONLY: one
    // new table, two guarded FKs, no ALTER on an existing table, no DML.
    //
    // THREE hashes, and what must never join them is any statement that TOUCHES MAIL: the
    // table records commands about folders, and the runner's consequences (the rename's
    // multi-table swap, the delete's file-to-Trash) run in the worker's own transactions where
    // they are crash-tested — a migration that moved mail would be an organizer with no lease.
    // Both closed sets (`op`, `status`) are CHECKs INSIDE the CREATE (0041's replay rule), and
    // UNIQUE(folder_id) is the concurrency model: one command in flight per folder, the second
    // refused 409 with the honest sentence.
    "6df06ddde1c0a95a",   // folder_ops — op/status CHECK-closed, rename⇔to_folder paired, UNIQUE(folder_id)
    "54098c9b30263b54",   // FK folder_ops.mailbox_id → mailboxes.id  (guarded, re-runnable)
    "ad003300857ca041",   // FK folder_ops.folder_id → mailbox_folders.id  ON DELETE CASCADE (guarded)
  ],
  "0075_mailbox_signature": [
    // THE PER-MAILBOX SIGNATURE — the stored text a compose offers under the message when this
    // mailbox is the sender (owner ruling 2026-08-27). NULL is "no signature", the default and
    // the state of every existing row. ONE additive nullable text column on `mailboxes`, no
    // default, no NOT NULL, no CHECK, no index — 0073's shape one column over, with the length
    // bound living at the write site (`MAILBOX_SIGNATURE_MAX_CHARS`, a 400) because free text
    // closes no set and a database byte bound would answer 23514 to a person typing.
    //
    // ONE hash, and a SECOND would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one — an UPDATE here would be
    //    writing words into every account's outgoing mail, a claim no migration may mint.
    //    Absence IS the default.
    //  · **an index was added.** The column is read through account-scoped mailbox selects
    //    that already have their rows; nothing filters on signature text, ever.
    //  · **a CHECK was added.** See above — the ceiling is the service's, in words a person
    //    can read.
    "ce438a1b8fa371c7",   // mailboxes.signature  text (nullable, no default, NO backfill)
  ],
  "0076_junk_sweep_request": [
    // THE ONE-TIME QUARANTINE→\Junk SWEEP'S COMMAND STAMP (FOLDERS-SPEC.md §16.1). The API
    // stamps it on the user's press; the worker consumes it at the top of the mailbox's serial
    // cycle and clears only the value it observed (`sync_requested_at`'s discipline, mail 0049).
    // NULL is "no sweep owed" — every existing row. ONE additive nullable timestamptz on
    // `mailboxes`, 0073's shape one column over: no default, no NOT NULL, no CHECK (a timestamp
    // closes no set), no index (read by primary key for the one mailbox whose cycle runs).
    //
    // ONE hash, and a SECOND would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one — a backfilled stamp would
    //    be a sweep nobody pressed, which is the organizer acting on its own initiative, the
    //    exact boundary §16.1 keeps.
    //  · **an index was added.** The worker reads the column for ONE mailbox by primary key;
    //    nothing scans it.
    //  · **a `done_at` column was added.** "Never offered twice" is the CANDIDATE COUNT (mail
    //    still physically in ohmail/Quarantine), which a second column could only disagree with.
    "5954646982b56de7",   // mailboxes.junk_sweep_requested_at  timestamptz (nullable, no default, NO backfill)
  ],
  "0077_send_later": [
    // SEND LATER — the draft carries WHEN it should leave (`send_at` + `status = 'scheduled'`),
    // the Idempotency-Key the send will use (`send_key`, minted AT SCHEDULE TIME so a crashed
    // claim replays instead of re-delivering), and the failure sentence from an appointment
    // that could not be kept (`send_error`). All three additive, nullable, no defaults, NO
    // backfill — NULL is "no appointment / no failure", every existing row. The appointment
    // lives on `drafts` and never on `outbound_sends`, whose `pending` rows mean "an
    // invocation is live right now": no reservation exists until the appointment is due, so
    // the stuck-send alarm's reading survives by construction. The partial index is the
    // worker's due scan (`status = 'scheduled' AND send_at <= now()`) — a real SCAN every
    // cycle, unlike the by-primary-key doorbell reads (mail 0049/0076), held to just the live
    // appointments by the predicate.
    //
    // FOUR hashes, and a FIFTH would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one — an UPDATE writing
    //    `send_at` would be scheduling mail nobody asked to send, and one writing `send_key`
    //    would be minting a send reservation's identity inside a journal file.
    //  · **a CHECK was added.** `drafts.status` has never been CHECK-constrained, and a
    //    cross-column "send_at requires scheduled" CHECK is falsified on purpose by the
    //    worker's claim window, where 'draft'/'sending' rows legitimately carry `send_at`
    //    as the crash-recovery predicate.
    //  · **the index lost its predicate.** Unpartial, it indexes every draft ever written to
    //    serve a scan over approximately zero rows.
    "a8d1e5e441d9c2d8",   // drafts.send_at     timestamptz (nullable, no default, NO backfill)
    "c3f354d0ac0f828e",   // drafts.send_key    text        (nullable, no default, NO backfill)
    "d26295ca27fcf3d7",   // drafts.send_error  text        (nullable, no default, NO backfill)
    "a85dd851952481f0",   // drafts_scheduled_due_idx — PARTIAL (send_at) WHERE status = 'scheduled'
  ],
  "0078_inbound_quiet": [
    // THE FORWARDING-DETECTION NOTICE (mail 0078) — a quiet episode's evidence and its
    // dismissal, two nullable timestamptz on `mailboxes`. `inbound_quiet_since` is written by
    // the worker's inbound-quiet pass alone (the predicate's single owner) and read by the
    // mailbox DTO; `inbound_quiet_dismissed_at` is written by the user's dismissal route and
    // read by nothing on the server — the client's `dismissedAt < since` comparison is the
    // whole renotify discipline. Both additive, no defaults, no NOT NULL, NO backfill: NULL is
    // "no episode / never dismissed", the truth for every existing row.
    //
    // TWO hashes, and a THIRD would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one — a backfilled episode
    //    would be the product claiming it had judged a mailbox it never judged, and a
    //    backfilled dismissal would be answering a notice on the user's behalf.
    //  · **an index was added.** The pass reads the account's own mailboxes by `account_id`
    //    and writes by primary key; nothing scans these columns.
    //  · **a CHECK was added.** Timestamps close no set (0076's rule, one column over).
    "f174349dc489af61",   // mailboxes.inbound_quiet_since         timestamptz (nullable, NO backfill)
    "1aaee47c1d229d65",   // mailboxes.inbound_quiet_dismissed_at  timestamptz (nullable, NO backfill)
  ],
  "0079_erasure_fence": [
    // THE ERASURE FENCE (mail 0079) — `accounts.erased_at`, the durable marker `deleteAccount`
    // stamps FIRST in its transaction and every settings writer reads FOR SHARE first
    // (`packages/services/src/erasure-fence.ts`), so a settings write in flight across an
    // Art. 17 erasure cannot recreate the swept rows. One additive nullable timestamptz, no
    // default, NO backfill: NULL is "never erased", the truth for every existing row — erasures
    // that predate the column left no writer alive to fence, and back-stamping them would
    // invent an instant nobody recorded.
    //
    // ONE hash, and a SECOND would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one — see the backfill line.
    //  · **an index was added.** The fence reads the row by primary key.
    //  · **a CHECK was added.** Timestamps close no set (0076's rule).
    "00e8ffa409db29f2",   // accounts.erased_at  timestamptz (nullable, NO backfill)
  ],
  "0080_sessions_access_token_hash_idx": [
    // THE AUTHENTICATION LOOKUP'S INDEX (mail 0080) — `sessions (access_token_hash)`. Every
    // authenticated request resolves its session by that column and the table carried no index
    // for it, so the predicate was a sequential scan over every session the deployment had ever
    // minted. Plain, not unique, not partial, not CONCURRENTLY — the migration file states each
    // of those four choices and why.
    //
    // ONE hash, and a SECOND would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one — an index migration that
    //    also writes rows is two migrations sharing a transaction.
    //  · **a second index was added.** The auth predicate is one equality plus two liveness
    //    rechecks on one heap tuple; a second index would be for a different query and belongs
    //    with that query.
    //
    // PAID LATE, and recorded rather than quietly corrected: this entry, the mail entry count
    // below, `baseline-adoption.test.ts`'s frozen list and `search-extensions.pg.test.ts`'s
    // MAIL_ENTRIES were all still at 0079 when mail 0081 was written, so this suite had been red
    // at HEAD since 0080 landed. The `/health` half of 0080's bookkeeping was fixed on its own in
    // a follow-up; the four literals here were not, which is the same lateness that note warns
    // about, one migration later.
    "adcf7f9d2b19e12b",   // CREATE INDEX sessions_access_token_hash_idx ON sessions (access_token_hash)
  ],
  "0081_sensitive_rescreen_cursor": [
    // THE RE-SCREEN'S RESUME POINT (mail 0081) — `mailboxes.sensitive_rescreen_cursor`, the last
    // `messages.id` of the last COMMITTED page of the one-time sensitivity re-screen. The pass is
    // bounded in rows and correctly declines to stamp its completion marker when it stops
    // short; the position it stopped at was ordinary JS state, so the next run began again at the
    // start and a mailbox whose candidate prefix is all STAYERS (rows the re-evaluation
    // deliberately leaves in place, which never drop out of the candidate query) could never
    // reach the misrouted mail behind them. The same column as `rules.retro_cursor` (0034) and
    // `account_settings.ohbox_tidy_cursor` (0043), on the one pass of that family that lacked it.
    //
    // TWO hashes — the resume point and the instant of the walk it belongs to. The second is not
    // decoration: the completion check that keeps this pass from stamping over mail it never
    // examined has to look back over the WALK, which outlives one process, and a run's own start
    // instant cannot express that. A THIRD would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one. Back-filling a resume point
    //    would declare a prefix examined that nothing examined, and the pass would skip it — the
    //    exact mail-losing outcome the column exists to prevent, written in by the migration
    //    that adds it. NULL is "start at the beginning" and is the truth for every existing row.
    //  · **an index was added.** The columns are read and written by primary key
    //    (`mailboxes.id`), and the completion check reads `folder_state` by the walk's own
    //    indexed candidate predicate.
    "764ad6f4391138fd",   // ALTER TABLE mailboxes ADD COLUMN sensitive_rescreen_cursor uuid
    "dfba76fbc6a1be54",   // ALTER TABLE mailboxes ADD COLUMN sensitive_rescreen_started_at timestamptz
  ],
  "0024_auth_events_reuse_index": [
    // Cloud 0024 — the reuse-revocation reads' partial index (`event = 'refresh_reuse_revoked'`
    // only, so it holds the rare sweep rows and never the login ledger). `auth_events`' one
    // existing index is `(user_id, at)`, which serves neither the alert rule's `event + at`
    // predicate nor the account view's `account_id + event`; without this, the pass that pages
    // a human scans the whole login history every minute. One hash, so a second statement —
    // a backfill, a widening — stops the suite.
    "d8f667beb3323c78",   // auth_events_reuse_account_at_idx — PARTIAL (account_id, at)
  ],
  "0025_alert_renotify_signature": [
    // Cloud 0025 — the renotify policy's one column: `alert_state.notified_signature`, the
    // condition signature of the last claimed/confirmed notification, which is what lets the
    // alert pass hold an UNCHANGED standing warning to a daily reminder and re-page a CHANGED
    // one at once (`runAlertPass`'s claim writes it, the release restores it). Nullable and
    // additive on a bookkeeping table whose rows the condition-clear DELETEs anyway; NULL —
    // every pre-migration row — deliberately reads as "unchanged" so the deploy cannot page
    // every standing alert once. ONE hash, so a second statement — a backfill, a widening —
    // stops the suite. In particular there must never be a DATA statement here: writing
    // `notified_at`/`notified_signature` from a migration is deciding what an operator has
    // already been told, which is the pass's claim protocol's decision alone.
    "891e0ce59d3801ff",   // ALTER TABLE alert_state ADD COLUMN IF NOT EXISTS notified_signature text
  ],
  "0026_alert_claim_lease": [
    // Cloud 0026 — the notify claim's lease, stated as its own column: `claimed_until` is
    // claim-time + TTL while a page is in flight, cleared by the settle, expired by the clock
    // on a crash. It exists so `notified_at` can mean exactly "the last CONFIRMED
    // notification": the lease used to be encoded there, and the renotify policy's
    // changed-condition arm misread a live lease as an ancient confirm — a second driver could
    // reclaim a mid-delivery row and page a duplicate. ONE hash; 0025's no-data rule applies
    // verbatim (writing lease or confirm state from a migration would be deciding what an
    // operator has been told).
    "4b8795e0e8171cfa",   // ALTER TABLE alert_state ADD COLUMN IF NOT EXISTS claimed_until timestamptz
  ],
  "0009_mailbox_oauth": [
    // Cloud 0009 — the OAuth consent ceremony and the operator's Entra application registration.
    // THREE statements: two CREATE TABLEs and one index. Deliberately NO data statement, and the one
    // that must never appear here is an `INSERT INTO oauth_provider_config` seeding a client id: a
    // registration belongs to whoever deployed this, and shipping one in a migration would point
    // every database that takes it at somebody else's Entra application.
    //
    // Inline FKs inside `CREATE TABLE IF NOT EXISTS` (not bare `ADD CONSTRAINT`s) so a journal replay
    // skips the whole statement instead of raising 42710 on the constraint — the 0037 trap. Same for
    // the CHECK, which is inline rather than a separate `ALTER TABLE … ADD CONSTRAINT`.
    //
    // Three hashes, so appending a fourth statement stops the suite.
    "6960fdf294ae2c30",   // CREATE TABLE mailbox_oauth_ceremonies (state PK, account_id→accounts)
    "f30e4e3ce3d4124f",  // mailbox_oauth_ceremonies_created_idx — the prune's probe
    "a10652e73fdd9a68",       // CREATE TABLE oauth_provider_config (provider PK, updated_by→staff_users, sealed-together CHECK)
  ],
  "0007_staff_users": [
    // the admin console's own login. Staff identity is deliberately NOT a column on
    // `users`: that table is the CUSTOMER identity, joined to `accounts`, and a `role='staff'`
    // flag on it would make every over-broad predicate in the product's auth path a possible
    // escalation into cross-account access. These tables are never queried by the product.
    //
    // Ten hashes and not one, so appending an eleventh statement stops the suite. The two
    // CHECKs and the guarded REVOKE are the ones worth re-reading if this list ever changes:
    // they are what keep a half-sealed TOTP secret unrepresentable and the content-blind role
    // out of the credential tables.
    "2c198c01533ebbb2",   // staff_users — email, scrypt hash, sealed TOTP secret, last_login_at
    "5386000cb93b007c",   // drop  CHECK totp_sealed_together  (re-runnable)
    "87ba49fcef6aa4a3",   // CHECK: secret_enc IS NULL == key_version IS NULL — one fact, not two
    "85a92350d7320779",   // drop  CHECK activated_needs_secret (re-runnable)
    "ec922f876ee31db9",   // CHECK: cannot be `activated` with no secret to verify against
    "fa1ca6d6224b7790",   // staff_sessions — token HASH, expires_at, revoked_at
    "78ce35be4facd211",   // FK staff_sessions.staff_user_id → staff_users.id, ON DELETE CASCADE
    "d963a1cd00b5520c",   // staff_sessions_user_idx
    "e510ec4520cfd9f7",   // staff_sessions_live_idx — PARTIAL, `revoked_at IS NULL`
    "d93a6b4f30ee6627",   // belt-and-braces REVOKE from ohmail_admin, guarded on the role existing
  ],
  "0082_theme_face": [
    // THE APPEARANCE FACE (mail 0082) — `account_settings.theme_face`, `'paper' | 'ohmarchy'`
    // or NULL, the account-wide half of the paper/ohmarchy setting (`locale`'s shape, with the
    // stored-default inversion the migration's header argues). One additive nullable column and
    // its closed-set CHECK, written re-runnably (DROP IF EXISTS + ADD) like 0053's pair.
    //
    // THREE hashes — the column, the guard's re-runnable drop, and the CHECK. A FOURTH would
    // mean a DATA statement was appended, and there must never be one: back-filling a face
    // would stamp a choice nobody made onto every device of every account.
    "7a531f9464df7790",   // account_settings.theme_face  text NULL
    "bf22c7e74632f6f7",   // drop  CHECK theme_face_supported  (re-runnable)
    "ec164b094c91b6da",   // CHECK: NULL or 'paper' | 'ohmarchy' — the closed set
  ],
  "0083_organizer_role": [
    // THE ORGANIZING ROLE, SPLIT OFF THE CONNECTION (mail 0083) — six columns on `mailboxes`,
    // two on `account_settings`, one on `mailbox_folders`, four closed-set CHECKs and TWO data
    // backfills. The migration's own header carries the argument; what this list is for is that
    // somebody reads the two UPDATEs before they are blessed.
    //
    // FIFTEEN hashes. A SIXTEENTH means a statement was appended, and for this tag that is the
    // one to stop on: the two UPDATEs below are the only DML in the file, they are the reason it
    // needs reading, and a third would be rewriting customer rows nobody argued for.
    "e9c39f8758dcea19",   // mailboxes.organizer_role         text NOT NULL DEFAULT 'organizer'
    "583f37ae1ec7b38c",   // mailboxes.organized_by_kind      text NULL
    "8ecb182aca1e59e8",   // mailboxes.organized_by_name      text NULL  (a customer machine name)
    "b230601f15a81bc2",   // mailboxes.organized_since        timestamptz NULL
    "80f7a86b0bcbab58",   // mailboxes.organizer_state        text NULL
    "d63307b36ee1fbd2",   // mailboxes.organize_consented_at  timestamptz NULL
    "08ff63d1ec06b3dd",   // account_settings.onboarding_completed_at  timestamptz NULL
    "08e3a46cbf5ff191",   // account_settings.screening_scope text NOT NULL DEFAULT 'window'
    "bae143baa85d23a0",   // mailbox_folders.server_exists    integer NULL
    "ae0d96e5196c9fbe",   // CHECK: organizer_role IN ('organizer','reader')          — NOT NULL set
    "ef51f40f9d669db6",   // CHECK: organized_by_kind NULL or ('cloud','local','unknown')
    "5e10720def083688",   // CHECK: organizer_state   NULL or ('held','stopped')
    "446c7ad9a297b845",   // CHECK: screening_scope IN ('window','all_time')          — NOT NULL set
    // ── THE TWO BACKFILLS, AND THEY ARE THE REASON THIS ENTRY EXISTS ──────────────────────
    //
    // (1) rewrites `status` on rows the product itself wrote, and it is the ONE cross-cutting
    //     statement in this migration: a stood-down mailbox is `disabled` only because the
    //     stand-down had nowhere else to record the role, and leaving it would ship the feature
    //     with its whole existing population invisible. The `NOT EXISTS` is not tidiness — it is
    //     the `mailboxes_active_address_uq` guard, without which a promoted row whose address was
    //     re-connected in the meantime violates a partial unique index and takes the deploy down.
    //
    // (2) stamps consent on every connected row. It is a RECORD OF SOMETHING THAT HAPPENED —
    //     connecting a mailbox was the consent under the old copy — not an invention, which is
    //     the line 0027 drew when it refused to backfill `takeover_authorized_at`. Without it the
    //     gate reads every live mailbox as un-consented and the deploy demotes production.
    "ec01cf9a186f1294",   // UPDATE: stood-down rows → connected readers, holder kind from the reason
    "8d5e1671007ed72f",   // UPDATE: organize_consented_at = created_at on every connected row
  ],
  "0084_ai_answered": [
    // "HAS ANYBODY BEEN ASKED ABOUT AI?" (mail 0084) — one column on `accounts` and ONE data
    // backfill. The column exists because `accounts.ai_enabled` rests `true` and a resting value
    // is not an answer: a fresh hosted account reported "AI is on" and the first-run flow walked
    // past the question entirely, on an account whose credits it was already spending.
    //
    // TWO hashes, and the second is the one this list exists to make somebody read.
    //
    // THE UPDATE TOUCHES ONLY `ai_enabled = false` ROWS, and that scope is the whole argument.
    // `false` is reachable only by an explicit answer (the default and the missing-row fallback
    // are both `true`), so stamping those rows records a decision that demonstrably happened.
    // There is deliberately NO statement for `ai_enabled = true`: that is the resting value, and
    // stamping it would write "answered" across every account in production and make the flow
    // skip the question for ever — shipping the defect as data, where no later fix could tell a
    // stamped account from an answered one. `erased_at IS NULL` keeps it off the rows of people
    // who asked to be forgotten. A THIRD hash means a statement was appended; for this tag that
    // is the one to stop on.
    "88df2cfb6248b132",   // accounts.ai_answered_at  timestamptz NULL
    "c5798c5b152a9388",   // BACKFILL: stamp only the accounts that explicitly switched AI OFF
  ],
  "0085_heal_disabled_readers": [
    // THE ROWS THE OLD WORKER WROTE AFTER 0083'S BACKFILL RAN (mail 0085) — one statement, and it
    // is DML, so this list is the place somebody reads it.
    //
    // It is 0083's own promotion statement re-run, byte for byte in its predicate: same
    // `status = 'disabled' AND disabled_reason IS NOT NULL`, same `split_part` for the holder
    // kind, same `NOT EXISTS` guard against `mailboxes_active_address_uq`. What changed is only
    // WHEN it runs — the old worker kept writing the pre-0083 encoding after the migration had
    // already swept it, and those rows are `disabled`, therefore off the roster, therefore
    // unreachable by the new worker for ever.
    //
    // `IS NOT NULL` means `organized_elsewhere:*` by SCHEMA, not by assumption:
    // `mailboxes_disabled_reason_closed` (0027) admits only those three values, so a user's own
    // disconnect — which carries no reason — is untouched. The consent stamp 0083 paired with
    // this is deliberately NOT repeated; the migration header carries that argument.
    //
    // A SECOND hash means a statement was appended, and for this tag that is the one to stop on.
    "ec01cf9a186f1294",   // BACKFILL: promote the stranded disabled readers, holder kind from the reason
  ],
  "0086_heal_reader_address_wide": [
    // THE HEAL, RESTATED WITH THE GUARD IT SHOULD HAVE HAD (mail 0086) — one statement, DML, so
    // this list is where somebody reads it.
    //
    // Identical to 0085's in its SET and its predicate but for the sibling test, which is now on
    // the ADDRESS ALONE: `o.account_id = m.account_id` is gone. The earlier migration was written about
    // `mailboxes_active_address_uq` (UNIQUE per account+address) rather than about the mailbox,
    // and two ohmail accounts can hold rows for one address — production had exactly that, with
    // one row stranded and off the roster, so promoting it produced a second organizer for one
    // IMAP mailbox.
    //
    // STRICTLY NARROWER than 0085: every row 0085 skips, this skips too. And a NO-OP on today's
    // data, which `heal-reader-address-wide.pg.test.ts` asserts by seeding the three rows that
    // database actually holds and requiring that none of them moves — the lease has already
    // arbitrated that pair and a journal statement may not reopen it.
    //
    // A SECOND hash means a statement was appended; for this tag that is the one to stop on.
    "74f7f507fb7e3e1d",   // BACKFILL: heal a stranded reader only where NO connected row shares its address
  ],
  "0027_oauth_device_ceremonies": [
    // THE DEVICE-CODE CEREMONY (cloud 0027) — the self-host door's in-flight state, in its own
    // table rather than as columns on `mailbox_oauth_ceremonies`. The redirect ceremony's
    // `code_verifier_enc` is NOT NULL and a device ceremony has no PKCE verifier to put there, so
    // sharing would have meant dropping a live invariant or writing a dummy value; and the two have
    // OPPOSITE consumption disciplines (that one is spent by the request that reads it, this one is
    // read repeatedly and claimed only on a terminal verdict).
    //
    // TWO hashes — the table and its prune index. A THIRD would mean one of these, each of which
    // needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one. These rows are live sign-in
    //    ceremonies holding a sealed bearer credential; back-filling or rewriting one is minting
    //    or altering somebody's in-flight consent.
    //  · **a NOT NULL was relaxed.** `device_code_enc` and `device_code_key_version` are NOT NULL
    //    TOGETHER, which is what makes an envelope nothing can open unrepresentable — the pair is
    //    sealed by the column definitions rather than by a CHECK.
    //  · **`consumed_at` gained a default or a NOT NULL.** Its NULL-ness IS the state the
    //    single-use claim turns on (`WHERE state = $1 AND consumed_at IS NULL`), and a default
    //    would make every freshly minted ceremony already spent.
    "7633fa8aee0f8e70",   // mailbox_oauth_device_ceremonies — sealed device_code, display values,
                          // the cumulative poll interval, the grant's own deadline, consumed_at
    "283682699f32d9a4",   // mailbox_oauth_device_ceremonies_created_idx — the prune's key
  ],
  /**
   * mail 0087 — THE AWAY RESPONDER'S PER-PERSON THROTTLE, ITS LEDGER, AND AN ENABLEMENT INSTANT.
   *
   * Twelve statements, all additive: two columns on `away_responders`, a closed four-member CHECK
   * (dropped-then-added so a replay is re-runnable), the `enabled_at` backfill, the two new tables
   * with their own CHECK and indexes, and the seed that carries 0051's record forward.
   *
   * Reviewed for this list on the three questions the exemption exists to ask:
   *
   *  · **Nothing is DESTRUCTIVE.** No DROP COLUMN, no DELETE, no rename. `away_responders.subject`
   *    and `away_responder_sent` are deliberately LEFT STANDING — an API one deploy older selects
   *    whole rows, and the seed reads the old table — so the only DML is one guarded UPDATE
   *    (`WHERE "enabled_at" IS NULL`, so a replay writes nothing) and one `ON CONFLICT DO NOTHING`
   *    INSERT.
   *  · **Nothing widens what a row may hold.** Both new CHECKs are closed enums; the two new
   *    columns are NOT NULL with a default, or nullable by design.
   *  · **The seed only ever SUPPRESSES**, and by one throttle interval rather than for the whole
   *    away window — the migration's own header states the limit and the behaviour change it
   *    implies for a responder that was live when it ran.
   */
  "0087_away_reply_throttle": [
    "94999007271ceaf7",   // away_responders.throttle text NOT NULL DEFAULT 'per_day'
    "3793648ae82f5f77",   // away_responders.enabled_at timestamptz NULL — the candidate floor
    "4d9aefe8563bcdfa",   // DROP CONSTRAINT IF EXISTS away_responders_throttle_closed (re-runnable pair)
    "3f542484defc1e6d",   // ADD CONSTRAINT away_responders_throttle_closed — the closed four-member enum
    "7761eb1644a103e8",   // UPDATE … SET enabled_at = updated_at WHERE enabled AND enabled_at IS NULL
    "93fa2839b743bc43",   // away_replies — one row per DECIDED candidate; no FK to messages
    "a35e8bd152098afd",   // DROP CONSTRAINT IF EXISTS away_replies_outcome_closed (re-runnable pair)
    "326ff1aeab92fb1c",   // ADD CONSTRAINT away_replies_outcome_closed — the five-member outcome enum
    "b907d6f1aaf2bbfb",   // away_replies_message_uq — THE RESERVATION, not a diagnostic index
    "bae373b9db597e71",   // away_replies_sender_idx — "why was this person not answered"
    "f0a5783bb00016e0",   // away_sender_state — PK (account_id, sender) IS the throttle's serialiser
    "afc523cb6a5527aa",   // INSERT … SELECT max(sent_at) FROM away_responder_sent … ON CONFLICT DO NOTHING
  ],
  /**
   * CLOUD — the credit roll-up's read path, and the setup pool re-keyed to the account.
   *
   * TEN hashes, and an ELEVENTH would mean one of these, each of which needs reading:
   *
   *  · **a DATA statement was appended.** There must never be one, and here the one that would
   *    be catastrophic is a `DELETE FROM credit_ledger` — the exact act this whole migration
   *    exists to make unnecessary. It would not even succeed: `credit_ledger_append_only` raises
   *    on DELETE, so a journal file attempting it aborts the migration. That is the right
   *    outcome and it is not a reason to stop reading for it here, because the second shape is
   *    quieter — an `UPDATE credit_usage_daily` or a seeded `credit_usage_totals` row would be
   *    money figures written by hand into the tables the console reports from.
   *  · **more DDL landed on `credit_ledger`.** The rule this migration is built on is that it
   *    touches that table with TWO INDEXES and nothing else — no column, no constraint, no
   *    trigger change. Both are `CREATE INDEX IF NOT EXISTS` (hashes #5 and #6). A third
   *    statement naming `credit_ledger` means somebody decided the money trail needed changing
   *    to make a read cheaper, which is the trade this design refuses.
   *  · **the partial predicates moved.** `credit_ledger_events_idx`'s `WHERE reason IN (…)` is
   *    the same six-reason set `LEDGER_EVENT_REASONS` in `admin-service.ts` queries with; if
   *    they diverge the query silently stops using the index. `setup_grants_account_once_uq`'s
   *    `WHERE kind = 'account'` is what makes "one pool per account, ever" a table fact while
   *    leaving the historical per-mailbox rows (several per account, legitimately) alone —
   *    widening it to the whole table would fail on existing data, and dropping it lets two
   *    concurrent first connections both mint a pool.
   *  · **`kind`'s DEFAULT was flipped.** `'mailbox'` is load-bearing: it is what makes the
   *    column additive over the existing population, so every pre-0028 row keeps meaning what it
   *    meant and `grantSetupCredits`' any-row refusal sees them. A default of `'account'` would
   *    retro-declare every historical per-mailbox pool to be the once-per-account one.
   */
  "0088_symmetric_takeover": [
    // SYMMETRIC TAKEOVER (mail 0088) — four additive nullable columns on `mailboxes`, one new
    // table, its two closed-set CHECKs written re-runnably (0053's DROP IF EXISTS + ADD pair) and
    // the drain's index.
    //
    // TEN hashes, and the property this entry exists to make somebody check is the absence:
    // **there is no DML in this file at all.** 0083's entry argues why its two backfills were
    // records of things that happened; the same argument refuses one here. Stamping
    // `organizer_event_at` on existing rows would announce an organizing change to every account
    // on the deploy that introduced the notice, for an event nobody recorded and most people have
    // already seen in the pane. An ELEVENTH hash therefore means a data statement was appended,
    // and that is the one to stop on.
    "e31648552f824f06",   // mailboxes.organizer_event_at       timestamptz NULL — when it changed
    "dea1ef4864689d83",   // mailboxes.organizer_event_seen_at  timestamptz NULL — when it was seen
    "2ded915322fe4452",   // mailboxes.release_requested_at     timestamptz NULL — the ASK
    "1b1cd2f10ea8eea3",   // mailboxes.organizer_released_at    timestamptz NULL — the RECORD
    "3096ad5d8fd13ef4",   // organizer_requests — the reader's own bookkeeping; NO foreign keys
    "a13f9c93de204173",   // drop  CHECK organizer_requests_state_closed  (re-runnable)
    "4018ffcb456c569f",   // CHECK: state IN ('pending','sent','applied','expired')
    "124722402dcb62e3",   // drop  CHECK organizer_requests_kind_closed   (re-runnable)
    "426b804ea4d7586f",   // CHECK: kind  IN ('screener.decide','rule.create','rule.update','rule.delete')
    "52041b078fe911ff",   // organizer_requests_mailbox_state_idx — the drain's read, once per cycle
  ],
  /**
   * CLOUD — revenue in and cost out: the invoice mirror and the two cost tables.
   *
   * TEN hashes, and the file holds ELEVEN statements. The eleventh is
   * `ALTER TABLE billing_reconciliation_runs DROP CONSTRAINT IF EXISTS billing_recon_runs_mode_check`,
   * which is BYTE-IDENTICAL to the one cloud 0023 already carries and is therefore already
   * exempted under that tag. Listing it twice would not be wrong so much as misleading: the
   * exemption set is keyed by content, so a second entry would silently pin the SAME statement
   * and one of the two tags would look like it had lost a statement if 0023's were ever edited.
   *
   * An ELEVENTH hash under THIS tag means one of these, each of which needs reading:
   *
   *  · **a DATA statement was appended.** There must never be one, and the shapes that would be
   *    worst here are an `INSERT INTO platform_costs` or an `UPDATE ai_usage_daily` — money
   *    figures written by hand into the two tables the margin is computed from, indistinguishable
   *    on the board from a measurement. The whole design of `platform_costs` is that an
   *    unmeasured window has NO ROW; a seeded one would defeat it in the journal.
   *  · **DDL landed on `billing_events`.** It must not. The reason `billing_invoices` exists at
   *    all is to stop the console needing `billing_events.payload` — the column that carries a
   *    customer's name and postal address — so a statement in THIS file touching that table is
   *    the design being undone by the migration meant to close it.
   *  · **the `mode` CHECK was re-widened.** Hash #9 is the replacement that admits `'invoices'`,
   *    and the third word is what keeps the invoice pass out of `evaluateAlerts`' staleness read
   *    (`mode = 'apply'`). A fourth word, or a drop with no re-add, puts one pass's health back
   *    in front of another's — the "guard satisfied by the wrong pass" defect the 0028 review
   *    found one migration ago.
   *  · **a CHECK moved off `billing_invoices`.** `status`, `source`, `plan` and
   *    `billing_interval` are CHECK-constrained precisely so the isolation sweep's marker is
   *    REFUSED by the database rather than excused by a test file; dropping one silently moves
   *    that column out of `REFUSED_BY_CONSTRAINT` and into "nobody classified it".
   */
  "0030_heartbeat_signals_alert_runs": [
    // CLOUD — the incident/signal split, the alerting's own pulse, and the two counters the new
    // reliability rules read. Twenty-one hashes — nineteen from the first draft and the CHECK
    // pair added after it — and each is a decision worth re-reading if it ever changes:
    //
    //  · **the three `alert_state` columns.** `cls` decides DELIVERY, not presentation, so its
    //    DEFAULT is the load-bearing character in the file: `'incident'` means a row written by a
    //    driver that predates the column, or by a rule whose author forgot the field, still
    //    pages. Flip that default to `'signal'` and every such row becomes one that fires,
    //    renders on the board, and reaches no human — the exact silence the alert subsystem
    //    exists to refuse, arriving as a one-word diff.
    //  · **the CHECK on `cls`.** Two words, closed. Without it a typo in a rule (`"signals"`)
    //    is accepted by the database, is not `'incident'` at the reader, and silently stops
    //    paging for that rule alone.
    //  · **the CHECK on `alert_pass_runs.driver`.** The set of drivers is closed because
    //    `alert_driver_dark` watches the OTHER driver BY NAME: a third arm that inserted itself
    //    here would be an arm nobody watches, which is a driver whose death is invisible — the
    //    one thing this table was added to make impossible.
    //  · **the CHECK on `platform_signals.provider`.** Same shape, and it is also what keeps the
    //    poller honest: a row from an unnamed provider is refused by the database rather than
    //    quietly summed into another project's traffic.
    //  · **`worker_heartbeats.ai_circuit_open_since`.** Nullable with no default, because NULL
    //    is the healthy state AND the state of a worker that predates the column — the only
    //    place those two must read identically.
    //  · **`alert_state.title` and `alert_state.count`.** NULLABLE, and the null is the honest
    //    part: a row from a driver that predates them has no title to project, so a reader says
    //    "recorded by the other driver" instead of fabricating one. They exist because every
    //    surface that READS this table rather than evaluating had to invent both — the count as
    //    a hardcoded 1, the title as the detail's first sentence — and that is the only path for
    //    the two driver-keyed rules and the role-scoped one. Placed BEFORE the final statement
    //    deliberately: two markers name that statement on the strength of it being last.
    //  · **`alert_pass_runs.sinks_configured`.** NOT NULL DEFAULT 0, and the default is the
    //    load-bearing character here exactly as `cls`'s is: a row written by a driver that
    //    predates the column reads as "no sinks", which every reader renders as UNHEALTHY. The
    //    other default would make an arm nobody has checked look armed. It exists because
    //    `sink_failure_streak` cannot express "cannot page anybody" — an arm that never attempts
    //    a delivery never fails one, so its streak sits at zero and reads as a healthy arm.
    //  · **`worker_heartbeats.degraded_since`.** The same shape and the same NULL argument, and
    //    it is here because the rule that reads it needs a DURATION. Without it `worker_degraded`
    //    measured uptime — "up ten minutes AND degraded right now" — which suppresses a boot and
    //    nothing after it, so one degraded beat on a day-old leader paged as a critical. Kept on
    //    the ROW rather than in the worker, so a leader change cannot reset the clock.
    "7d20c3f1f3a5b207",   // alert_state.cls  text NOT NULL DEFAULT 'incident' — the safe default
    "d338905eaaecb301",   // alert_state_cls_check dropped if present — re-runnable, like 0029's
    "693babcdd078e35e",   // alert_state_cls_check — the closed two-word set
    "e69ff68cff5da0fc",   // alert_state.affected_accounts  integer NULL — a COUNT, never a list
    "3ea28c10fa26daa1",   // alert_state.fix_href  text NULL — an internal console path
    "5183e8d1c638b8a6",   // alert_state.title  text NULL — what the rule SAID, never reconstructed
    "b8536f9e81719568",   // alert_state.count  integer NULL — the same, and it was a hardcoded 1
    "cdcb80f1428bd217",   // CREATE TABLE alert_pass_runs — PK is the driver word; one row per arm
    "4944463abb3079e8",   // alert_pass_runs_driver_check dropped if present
    "b474b51ee5c92658",   // alert_pass_runs_driver_check — 'worker' | 'api', and the pair is the design
    "e0591dee8f13060d",   // CREATE TABLE platform_signals — PK (provider, project, window_start)
    "320697f11748e862",   // platform_signals_provider_check dropped if present
    "23ede774922a2ca9",   // platform_signals_provider_check — the closed provider set
    "770890ed5517cddd",   // platform_signals_window_idx — the rule's 15-min read and the 7-day prune
    "b94548511b0ae837",   // worker_heartbeats.ai_circuit_open_since  timestamptz NULL
    "b7bdc08161305253",   // worker_heartbeats.degraded_since  timestamptz NULL
    "8965c31aeeca10d1",   // alert_pass_runs.sinks_configured  integer NOT NULL DEFAULT 0
    // 0030 GREW TWO STATEMENTS (the tombstone and the sample cause), and the schema marker
    // moved to the last of them in the same commit — a marker naming anything earlier
    // reports ready for a migration that stopped halfway.
    "1c4450e4e281719b",   // alert_state.resolved_at  timestamptz NULL — resolution marks, never deletes
    "9022a01b42f56901",   // platform_signals.sample_cause  text NULL — WHICH cause made it a sample
    // ── ADDED AFTER THE FIRST DRAFT OF 0030, and the pair is deliberate ──────────────────
    // `sample_cause` shipped as free text with its closed set living only in `SAMPLE_CAUSES`.
    // A closed set the reader alone enforces cannot be seen by anything that reads the schema,
    // and a value outside it renders an operator a blank line under a number they act on. The
    // DROP/ADD spelling rather than an inline constraint: a database that applied an earlier
    // draft holds the column WITHOUT the constraint, and `ADD COLUMN IF NOT EXISTS` would skip
    // and leave it that way. Widened ahead of any code that writes an eighth cause, never
    // narrowed — the same deploy rule `cls` and 0091's own CHECK carry.
    "2e7e15ae83e3d505",   // DROP CONSTRAINT IF EXISTS — the re-runnable shape, its own text
    "b9e42cd332153d66",   // CHECK: sample_cause IS NULL OR IN (…seven…) — widened, never narrowed
  ],
  "0089_organizer_capability": [
    // THE FIFTH HOLDER COLUMN (mail 0089) — one additive nullable column on `mailboxes`,
    // `organized_by_capabilities`, comma-joined and lowercased off the holder's own
    // `X-Ohmail-Capabilities` claim header. ONE hash, and a SECOND would mean a data statement
    // was appended — there is nothing to backfill here for 0088's own reason: an existing row has
    // no capability observation under a build that records one, and stamping a value would be an
    // invented fact rather than a recorded one.
    "fa9b52643e44bba5",   // mailboxes.organized_by_capabilities  text NULL — what the holder offers
  ],
  "0090_request_key": [
    // THE REFUSAL AN ORGANIZER CARRIES BACK (mail 0090) — one additive nullable column,
    // one WIDENED CHECK written re-runnably, one index.
    //
    // THREE hashes for FOUR statements, and the missing one is the property to check rather than
    // an omission. `ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS
    // "organizer_requests_state_closed"` is BYTE-IDENTICAL to the drop 0088 already carries, and
    // the exemption set is keyed by CONTENT — so it is already exempted under that tag and listing
    // it again would pin the same statement twice while looking like coverage of a new one. Cloud
    // 0029's entry records the identical situation for its own repeated drop.
    //
    // **THE FILE IS NAMED FOR A KEY IT NO LONGER STORES, and the tag is immutable, so the name
    // stays.** The first cut kept a per-account signing key in `account_settings` and shipped four
    // more statements for it. The key is now DERIVED from the mailbox password at use and never
    // stored, so those columns are gone — a local install has no authenticated call to fetch a key
    // on, and the two installs already share the one secret that draws exactly the right boundary.
    // An adopting database records the tag it ran; renaming the file would make this entry
    // disagree with that record.
    //
    // **There is no DML here**, on 0088's argument verbatim: there is nothing to backfill, because
    // a refusal is something an organizer says rather than a fact about existing rows. A FOURTH
    // hash therefore means a data statement was appended, and that is the one to stop on.
    "496d0f72f605969b",   // organizer_requests.refused_reason  text NULL — what the organizer said no to
    "44461cfceedfed60",   // CHECK: state IN (…,'refused') — WIDENED, never narrowed
    "10c22ceb5a56521b",   // organizer_requests_account_state_idx — the Screener list's own read
  ],
  "0094_request_kinds_moves_profile": [
    // TWO MORE KINDS A READER MAY ASK FOR, AND A PLACE FOR WHAT THE ORGANIZER ANSWERED (mail 0094).
    //
    // FOUR statements in the file and THREE hashes here, and that is not a miscount. The first —
    // `DROP CONSTRAINT IF EXISTS organizer_requests_kind_closed` — normalises to the same text as
    // 0088's own drop of the same constraint, so it hashes to `124722402dcb62e3`, which is already
    // exempt under `0088_symmetric_takeover`. A Set holds it once. Listing it again here would be
    // harmless and misleading: it would read as this migration having its own drop statement when
    // what it has is the same one, re-run.
    //
    // **There is no DML here**, on 0088's and 0090's argument: nothing is backfilled, because both
    // objects are about requests that do not exist yet and a document that has not been read yet.
    // A FOURTH new hash therefore means a data statement was appended, and that is the one to stop
    // on — the same tripwire 0091's entry describes from the other side, where the DML is real.
    //
    // The CHECK is WIDENED, never narrowed: `message.move` and `profile.update` join the four
    // members 0088 closed, so a row an older build wrote still satisfies it and an older build
    // keeps working against a migrated database.
    //
    // `mailbox_profile_mirror` carries `uidvalidity` beside `uid` because a remembered IMAP uid is
    // a fact only under the generation it was read under — the rule `message_instances_locator_uq`
    // and `message_failures_locator_uq` already encode, and 0028's marker states. It carries
    // `account_id` because the "Account isolation is absolute, and it binds staff too" invariant is a column here rather than a join every caller must
    // remember; see its `MAIL_TABLES` note.
    "4ec2944ff44b7e46",   // CHECK: kind IN (…, 'message.move', 'profile.update') — widened, never narrowed
    "ffd8e3fdfbf69c04",   // CREATE TABLE mailbox_profile_mirror — PK mailbox_id, (uidvalidity, uid) pair
    "d215c58e9b3a9a13",   // mailbox_profile_mirror_account_idx — the erasure sweep's and census's read
    /* AND THE REFUSAL VOCABULARY WIDENS WITH THE KIND THAT NEEDED IT. `message.move` has two
       outcomes 0091's eight words cannot say — `no_such_message` and `no_trash_folder` — so this
       file re-states 0091's constraint with ten members.

       SIX statements in the file and FOUR hashes here now, and the second collision is the same
       shape as the first: `DROP CONSTRAINT IF EXISTS organizer_requests_refused_reason_closed`
       normalises to the same text as 0091's own drop, so it hashes to `91ac4c78c6b156ab`, already
       exempt under `0091_request_refusal_closed`. A Set holds it once. Two drops, two collisions,
       two entries that do not appear here — and the ADD is new text because its member list is.

       The ADD's hash moved once more when `no_such_rule` joined for the `rule.*` appliers: eleven
       members now. That is the census working as intended — the constraint's identity IS its
       member list, so a widening that did not move this line would mean the members had not
       changed. */
    "f6e6ea21f0edf5c0",   // CHECK: refused_reason IN (…, 'no_such_message', 'no_trash_folder', 'no_such_rule')
  ],
  "0096_away_piles": [
    // MAIL — WHICH PILES THE AWAY RESPONDER ANSWERS, and which correspondents are unreachable.
    // Five statements: two columns, a repair, a CHECK dropped-then-added, and no destructive DML.
    //
    // ── WHAT WAS READ BEFORE THESE HASHES WENT IN ─────────────────────────────────────────
    //
    //  · `piles text[] NOT NULL DEFAULT '{INBOX}'` — a NARROWING of live behaviour, deliberately.
    //    A responder that is on when this runs stops answering mail filed to Reads or Receipts.
    //    That is the whole point of the migration (a responder set to "people I've let in" sent
    //    eight replies to shop and notification senders whose mail files itself away), and the
    //    default is the narrow member because widening what a standing order reaches cannot be
    //    undone — a reply already sent to somebody its owner did not mean is not recallable.
    //  · the `UPDATE` is a REPAIR, not a backfill, and it is the one statement here worth
    //    justifying. The column is created two lines above it, so no writer can have put a
    //    non-member in it and this cannot fire against any database this fleet has produced. It
    //    is here because the alternative to a repair is a FAILED migration at somebody's launch,
    //    which is 0091's rule. It touches only rows already outside the closed set and it can
    //    only ever narrow one — it never widens a scope and never enables a responder.
    //  · the CHECK is CONTAINMENT (`<@`), so the EMPTY array satisfies it. That is on purpose:
    //    a responder answering nobody is what unticking every box means, the rule handles it by
    //    name, and refusing it here would 400 that save. It is widened, never narrowed (0090's
    //    rule), so a build offering a third pile ships the widening ahead of the code.
    //  · `undeliverable_at` is nullable with no default and no DML. A bounce for an away reply
    //    stamps it, after which that correspondent is never written to again.
    //
    // A SIXTH hash would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** The only legitimate one is the repair above. An
    //    `UPDATE … SET piles = ...` that WIDENS would be a decision about who receives unattended
    //    mail, smuggled in as a schema change where no reviewer looks for one; an `UPDATE
    //    away_sender_state SET undeliverable_at = NULL` would be a fleet-wide re-arming of replies
    //    to addresses already known to bounce.
    //  · **the DEFAULT was widened.** `'{INBOX,ohmail/Reads}'` would opt every existing responder
    //    into Reads without anybody asking — the exact defect this migration exists to close.
    //  · **an index was added.** Neither column is a lookup key: `piles` is read with the
    //    responder row the probe already selects, and `undeliverable_at` is read through the
    //    `(account_id, sender)` primary key.
    //  · **`ohmail/Screener` joined the closed set HERE.** It may not join under THIS tag:
    //    0096's CHECK is the two-member one, and a fifth hash widening it would be a scope change
    //    wearing an older migration's number. The member itself is no longer forbidden — mail
    //    0101 admits it — and the contradiction this bullet feared (two settings ruling on one
    //    population) is closed by ORDER rather than by omission: the audience decides a waiting
    //    stranger first, and both write doors refuse that pile beside `screened_in`, so the
    //    contradictory row is unrepresentable.
    "0e540bc3daad8b2b",   // ALTER TABLE away_responders ADD COLUMN piles text[] NOT NULL DEFAULT '{INBOX}'
    "6dc24e933e054012",   // UPDATE away_responders SET piles = '{INBOX}' WHERE NOT (piles <@ …) — the repair
    "9a4793342097e5fb",   // ALTER TABLE away_responders DROP CONSTRAINT IF EXISTS away_responders_piles_closed
    "653c207ddb96a649",   // ALTER TABLE away_responders ADD CONSTRAINT away_responders_piles_closed CHECK (piles <@ …)
    "3ad5b454628fcf34",   // ALTER TABLE away_sender_state ADD COLUMN undeliverable_at timestamptz
  ],
  "0092_organizer_install_id": [
    // THE SIXTH HOLDER COLUMN (mail 0092) — one statement, no DML, nullable on purpose.
    //
    // `organized_by_kind` answers "what SORT of thing holds this mailbox" and was read as "is this
    // US", which are the same question only when there is one install per kind. Two Cloud
    // deployments over one mailbox is a designed-for state — the worker scopes the organizer id by
    // environment — so a `cloud` row may be this install's claim or another deployment's. The
    // release path read the kind, answered "ours", and cleared the row while the claim it could
    // not match stayed in the mailbox, so the row said released and the folder disagreed.
    //
    // NULL means "we cannot say it is ours" and every caller must read it as NOT ours: refusing a
    // hand-back that would have worked costs a sentence, offering one that silently fails costs
    // the trust of every sentence beside it. Idempotent, one statement, no breakpoint needed.
    "534c78f902c7d3cb",   // ADD COLUMN IF NOT EXISTS organized_by_install_id text
  ],
  "0097_folder_state_last_error_class": [
    // WHY A FILING WAS REFUSED, AS A CLASS (mail 0097) — one column, one CHECK, no DML.
    //
    // The status strip showed one sentence for every reason one of your own filings had not
    // reached the mail server: a move the organizer would make on its next turn and a move the
    // server had refused and put off for hours read identically. `attempts`/`next_attempt_at`
    // (mail 0058) already carry the SCHEDULE, which separates "asleep" from "due"; what was
    // missing is WHY, and without it the honest sentence cannot be written — "retrying at 14:20"
    // is true and unactionable where "the folder is not there" names the screen that fixes it.
    //
    // **`folder_state`'s schema comment forbids an error column and this does not break that
    // rule — it applies it.** The prohibition is on FREE TEXT: "what went wrong is free text from
    // someone else's mail server; it belongs in the `reconcile.move.failed` audit row". This
    // column holds one of four words this codebase chose, mapped from the server's structured
    // response code, with the CHECK below as the membership. The server's own wording still goes
    // only to the audit row.
    //
    // NO `created_at` BESIDE IT, and that absence was a decision. The obvious companion for "how
    // long has this waited" would be a creation stamp — and it would be WRONG: the table is keyed
    // by message and UPSERTED, one row per message reused at every re-filing, so a creation stamp
    // dates the message's FIRST filing and would report weeks of waiting over a decision made a
    // second ago. `updated_at` is the honest operand and the code already treats it as one (the
    // intent writers stamp it, `deferFolderReconcile` deliberately does not).
    //
    // Both statements idempotent, so a desktop engine replaying this journal at every launch is
    // unharmed; two statements, so the breakpoint marker is required and present.
    "e23eca260378a02f",   // ADD COLUMN IF NOT EXISTS last_error_class text
    "536b45e66fc78ed5",   // CHECK: NULL or one of the four classes — widened, never narrowed
  ],
  "0091_request_refusal_closed": [
    // THE REFUSAL'S VOCABULARY, MOVED INTO THE SCHEMA (mail 0091) — no column, one CHECK, and one
    // repair ahead of it.
    //
    // 0090 added `refused_reason` as free text and closed the set in code: an acknowledgement is
    // verified under the account's key before it is read, and its parser maps any reason outside
    // the eight-word vocabulary to NULL. The operator console's isolation sweep cannot see a
    // parser, only a constraint — so a set that lives only in code is classified as free text,
    // correctly, and that classification is what this migration changes.
    //
    // **THERE IS DML HERE, and it is the one thing to look at twice.** 0088's and 0090's entries
    // both record "no DML" as the property to check; this one has some, deliberately, and it can
    // not fire against any database this fleet has produced — no write path could have put an
    // unrecognised word in the column. It exists because the alternative to a repair is a FAILED
    // MIGRATION at somebody's launch, and because NULL is already this column's own word for "a
    // refusal I cannot name": forgetting an unreadable hint is what the parser does with one, so
    // the repair says the same thing. A SECOND data statement is the one to stop on.
    "c14e01ba43e8ac08",   // UPDATE: forget a reason outside the set — unreachable, see above
    "91ac4c78c6b156ab",   // DROP CONSTRAINT IF EXISTS — the re-runnable shape, its own text
    "00013316ac89d789",   // CHECK: refused_reason IS NULL OR IN (…) — widened, never narrowed
  ],
  "0093_outbound_send_fingerprints": [
    // THE ACCOUNT'S CLAIM ON THE CONTENT OF A SEND (mail 0093) — one table, two constraints.
    //
    // `outbound_sends` is unique on `(account_id, idempotency_key)`, a key the CLIENT owns, and
    // the reserve transaction separately refuses a second send of one DRAFT. Neither sees a client
    // that mints a fresh key AND composes a fresh draft holding the same message, which is a
    // second copy in somebody's inbox. So the account claims the content: a SHA-256 of what a
    // recipient can perceive, unique per `(account, mailbox)`.
    //
    // NO DML, unlike 0091's entry, and nothing here touches an existing table — the whole
    // migration is one new table plus its own constraints, so an adopting database cannot fail it
    // on data it already holds. The property to check twice is the CHECK: it is on a column the
    // send path alone writes and whose value is a digest, so it can be narrowed to a shape rather
    // than widened over time — the opposite of `organizer_requests.refused_reason` above, and the
    // reason is that no OTHER build can ever author a value for it.
    // The hash moved when the foreign key gained ON DELETE CASCADE — real SQL, not a comment, so
    // the statement's identity changed with it. Three cleanup paths delete `outbound_sends`
    // directly (the desktop mirror wipe, the local mirror's per-draft cleanup, account erasure) and
    // all three failed 23503 against a plain reference.
    "d4a3d1932cf3bba1",   // CREATE TABLE IF NOT EXISTS outbound_send_fingerprints (FK cascades)
    "c7e857243930b2c7",   // DROP CONSTRAINT IF EXISTS …_content_uq — the re-runnable shape
    "2614045f330e97d9",   // UNIQUE (account_id, mailbox_id, fingerprint) — the claim itself
    "f691a98887013585",   // DROP CONSTRAINT IF EXISTS …_hex — the re-runnable shape
    "504ac94238f88379",   // CHECK fingerprint ~ '^[0-9a-f]{64}$' — closed by shape, in the database
  ],
  "0095_outbound_send_resolution": [
    // MAIL — the resolution of a send this server could not confirm, and the constraint change
    // that finally lets the draft be discarded. Reviewed on the three questions this list exists
    // to ask:
    //
    //  · **Is there DML?** No. Four ALTERs and one re-runnable constraint add; not one row is
    //    read or written, and every existing row resolves to NULL/NULL, which is the truthful
    //    reading — nobody has resolved anything before this exists.
    //  · **Is it re-runnable?** Yes, and each statement carries its own guard rather than relying
    //    on the journal: `ADD COLUMN IF NOT EXISTS` twice, `DROP NOT NULL` (idempotent by
    //    definition), `DROP CONSTRAINT IF EXISTS`, and the `DO $$ … duplicate_object` block mail
    //    0013 established for this very constraint.
    //  · **What does the FK change give up?** The `NOT NULL` and `ON DELETE NO ACTION` on
    //    `draft_id`. That pair is why a discard of a draft with ANY send row raised 23503 and
    //    reached a caller as a 500 — measured for a `failed`, `sent` and `unverified` row alike —
    //    and so why the service refused the delete by name instead. `SET NULL` keeps the ledger
    //    row and drops only its pointer; the reservation's identity, and the replay gate that
    //    makes a same-key retry replay rather than deliver twice, is
    //    `UNIQUE(account_id, idempotency_key)` and does not mention the draft. NOT `CASCADE`,
    //    which would delete the gate along with the words.
    //
    // THE STATEMENT TO STOP ON if this file ever changes is the constraint add: it is the only
    // one whose text encodes a policy (`ON DELETE set null`) rather than a shape.
    "1e37e446b0af9453",   // ADD COLUMN IF NOT EXISTS resolved_by text
    "e888f5026dc7ddd0",   // ADD COLUMN IF NOT EXISTS resolved_at timestamptz
    "cadc710646c7377c",   // ALTER COLUMN draft_id DROP NOT NULL
    "5876ed471160e5d4",   // DROP CONSTRAINT IF EXISTS — the re-runnable shape, its own text
    "bbd98136fc6f9308",   // ADD CONSTRAINT … ON DELETE set null — the policy statement
  ],
  // ── MAIL 0098 — the signature's MARKUP half (0.16, Settings → Signatures gains the compose
  // editor's own formatting) ──
  //
  // THE REVIEW, since this entry is it: one ADDITIVE nullable text column on `mailboxes`, no
  // default, no CHECK, no back-fill and no DML. PostgreSQL rewrites no rows for it, every
  // existing row keeps NULL, and NULL is the truthful reading — "this signature has no markup
  // in it" is the state of every signature that existed before the editor could produce any.
  //
  // Nothing DESTRUCTIVE and nothing that could fail on a live table, which is what this census
  // exists to force somebody to say out loud. The value's authority argument (this column is
  // authoritative and `mailboxes.signature` beside it is derived from it by the server) is on
  // the migration itself; it is a statement about who WRITES the two columns, not about the
  // shape of this statement.
  "0098_signature_html": [
    "f5f870d5f5615d28",   // ADD COLUMN IF NOT EXISTS signature_html text
  ],
  // Mail 0099 — where a deleted message came from, so a restore can put it back there. ONE
  // additive nullable `text` column, no default and no backfill, so PostgreSQL rewrites no rows
  // and every existing row reads NULL, which is the truthful value: a delete taken before this
  // column existed recorded no origin. Nothing destructive, nothing that can fail on a live
  // table, and the statement is `IF NOT EXISTS` because the desktop replays this journal at
  // every launch.
  "0099_folder_state_trashed_from": [
    "d219e19ea7faecda",   // ADD COLUMN IF NOT EXISTS trashed_from text
  ],
  // ── MAIL 0100 — the one-time re-stamp of mail a second install of the account filed (0.17) ──
  //
  // THE REVIEW, since this entry is it: ONE statement, and the only DML in the mail journal that
  // rewrites a column on rows it did not create. It touches `folder_state.last_set_by` and
  // nothing else — no schema change, no default, no constraint, no delete — and its predicate is
  // three exclusions wide (the pair agreed inside the ohmail namespace, no `move` for that
  // message in the change log, the row predates the corrected writer). It is idempotent by
  // construction: the rows it writes stop matching `last_set_by = 'external'`.
  //
  // DESTRUCTIVE? It cannot lose a row and it cannot lose a person's placement: a placement made
  // by hand in someone's own mail client carries a `change_log` `move`, which the predicate
  // refuses. The one thing it CAN do is make those rows eligible for the retro passes again,
  // which is the repair. The row count it touched is raised as a notice.
  //
  // COST ON A LIVE TABLE: one anti-join against `change_log` filtered to `op = 'move'`, one pass.
  "0100_reader_window_peer_restamp": [
    "3731808ed4233593",   // DO $$ … UPDATE folder_state SET last_set_by = 'peer' … (one statement)
  ],
  // ── MAIL 0101 — Receipts and the Screener join the away responder's answerable piles ──────
  //
  // THE REVIEW, since this entry is it. TWO hashes for THREE statements: the `DROP CONSTRAINT
  // IF EXISTS` is byte-identical to 0096's and already exempted under that tag, because this set
  // is keyed by statement rather than by (tag, statement).
  //
  //  · the CHECK is REPLACED, wider: `{INBOX, ohmail/Reads}` gains `ohmail/Receipts` and
  //    `ohmail/Screener`. Widened, never narrowed (0090/0091's rule), so a row an older build
  //    wrote still satisfies it — and it is replaced BEFORE the UPDATE below, which is the only
  //    order in which that statement can write the new member at all. Containment (`<@`) still
  //    admits the empty array, a responder answering nobody, which the pile rule handles by name.
  //  · the UPDATE is the second statement in this journal that rewrites a column on rows it did
  //    not create, and it is BOUNDED three ways: `WHERE audience = 'everyone'` (rows on the
  //    narrow audience are untouched), `AND NOT ('ohmail/Screener' = ANY(piles))` (idempotent —
  //    the rows it writes stop matching, which is what a desktop replaying this journal at every
  //    launch needs), and `array_append` (it adds ONE member and removes none). It touches
  //    `away_responders.piles` and nothing else: no schema change, no default, no delete.
  //
  // DESTRUCTIVE? It cannot lose a row and it cannot widen what any responder answers. Until this
  // migration the pile rule EXEMPTED the Screener, so an `everyone` responder answered strangers
  // waiting there whatever its `piles` held; the code that lands with it consults the pile
  // instead. Without this statement those rows would silently stop answering that population —
  // a change to a live standing order nobody asked for. The UPDATE is what keeps behaviour
  // identical, which is the opposite of a widening: it stores what the row already did.
  //
  // A FOURTH hash would mean one of these, each of which needs reading: an `UPDATE … piles`
  // reaching `screened_in` rows (the pair the write doors refuse, and a scope no pass can act
  // on); `ohmail/Screened` or `ohmail/Quarantine` in the CHECK (a rejection and a phish are
  // unanswerable whatever the settings); or an `UPDATE away_responders SET enabled` of any
  // shape, which would be a decision about unattended mail smuggled in as a schema change.
  //
  // COST ON A LIVE TABLE: one pass over `away_responders`, which holds at most one row per
  // account, plus the constraint's own validation of the same rows.
  "0101_away_piles_wider": [
    "2e237b9ebbf9a92d",   // ALTER TABLE away_responders ADD CONSTRAINT away_responders_piles_closed CHECK (piles <@ … four members)
    "19d06af76785b760",   // UPDATE away_responders SET piles = array_append(piles, 'ohmail/Screener') WHERE audience = 'everyone' AND NOT (…)
  ],

  // ── CLOUD 0032 — the metering tables leave this schema ────────────────────────────────────
  //
  // ONE statement, and it is a guarded DROP rather than a DDL script: each of the sixteen tables
  // goes only where it is EMPTY, and a non-empty one is left in place with a warning naming its
  // row count. An install that metered holds the only copy of a money trail in `credit_ledger`,
  // so a blanket drop is a loss this file could not ask anybody to accept.
  "0032_retire_billing_tables": [
    "2e5871bafc0bd123",   // DO block: children before parents, then the four ledger functions
  ],

  "0033_api_faults": [
    // CLOUD — one new table and nothing else touched: the API's own 5xx record, which the two
    // reliability rules read. Nine statements, and the shape is the re-runnable one 0030
    // established: every constraint is DROPPED IF EXISTS and re-ADDED, so a database that took
    // an earlier draft of the file ends up with the constraint rather than silently without it
    // (`ADD COLUMN IF NOT EXISTS` skips, `ADD CONSTRAINT` does not).
    //
    // NO DML, and that is the property to check twice here: the table is created empty and the
    // rules that read it are counts over a moving window, so there is nothing to backfill and
    // nothing a repair statement could honestly write. A data statement appearing in this file
    // is the thing to stop on.
    //
    // WHAT EACH COLUMN MAY HOLD is the review this list stands in for. `route` is the matched
    // route PATTERN from the API's own table, never a request target; `error_class` is a class
    // NAME and never a message (a driver's message quotes connection strings, an application's
    // quotes what a person typed); `request_id` is our own uuid. The three CHECKs enforce that
    // reading in the database rather than only in the writer: 5xx only, so a caller's own
    // mistake cannot enter any rule's population; length ceilings, so one looping route cannot
    // grow the table by row SIZE; and a closed `arm` set, `alert_pass_runs.driver`'s shape.
    //
    // `arm` IS THE LAST COLUMN, deliberately, because `health-cloud.ts`'s marker and
    // `alerts.ts`'s SCHEMA_BEHIND_MARKER both name it — only the last column's presence implies
    // every object above it. Appending a column-adding statement here means moving both.
    "60a4392c7696efff",   // CREATE TABLE api_faults (id, at, route, method, status, error_class, request_id, arm)
    "204cd4f4b97e75e4",   // DROP CONSTRAINT IF EXISTS api_faults_status_check — the re-runnable shape
    "b62c592427492a63",   // CHECK: status between 500 and 599 — a 4xx is the API working
    "7458449afa2f2828",   // DROP CONSTRAINT IF EXISTS api_faults_len_check
    "e0e9f2180424e1fc",   // CHECK: length ceilings on route, method, error_class, request_id
    "f69911b92b8b614d",   // DROP CONSTRAINT IF EXISTS api_faults_arm_check
    "5e9000d9fdf2bbf0",   // CHECK: arm IN ('api', 'worker') — the closed set
    "1abb25d23c4ee96c",   // INDEX api_faults_at_idx — the prune's and the window's range scan
    "a4ccad12e79b4042",   // INDEX api_faults_at_route_idx — the per-route rule's grouping
  ],

  // Mail 102 — the fourth `sync_blocked_reason`, so a bounded read refusal stops reading as a
  // broken mailbox. TWO hashes because it is a REPLACEMENT: the closed set is dropped and
  // re-added under its existing name, which is the shape 0094 uses to stay re-runnable on a
  // desktop that replays this journal at every launch. The drop is `IF EXISTS`, the add carries
  // the whole four-member vocabulary, and neither can fail on a live table — no rows are
  // rewritten and no existing value is outside the widened set.
  "0102_sync_blocked_reason_read_limited": [
    "6f2de3de309aff74",   // DROP CONSTRAINT IF EXISTS mailboxes_sync_blocked_reason_closed
    "5d1bd40fe2c52b63",   // ADD CONSTRAINT … CHECK (… IN (…, 'read_limited'))
  ],

  // Mail 103 — `mobile` joins the organizer kinds, so a phone's own claim is rankable and it stops
  // handing its mailbox back to itself. FOUR hashes: the kind reaches this table twice, as
  // `organized_by_kind` and as the suffix of `disabled_reason`, and each is 0102's re-runnable
  // drop-then-add under its existing name. Widening one and not the other makes the other refuse
  // the write on a mailbox somebody is using.
  // Cloud 34 — the passkey ceremony table stops being permanent. ONE hash: an index on
  // `webauthn_challenges.expires_at`, no column, constraint or row touched. It is the key the
  // opportunistic prune walks, and the prune is what bounds a table that had no index and no
  // deletion in it. A DML statement appearing in this file is the thing to stop on.
  "0034_webauthn_challenge_expiry": [
    "c3670b365894c83b",   // INDEX webauthn_challenges_expires_idx — the prune's range scan
  ],

  // Cloud 35 — the same table's CONSUME read, which 0034's index cannot serve. TWO hashes and
  // two is the point: exactly one of `user_id` / `login_token_id` is non-null on any row, so one
  // leading column cannot serve both ceremony arms. Both are partial on `consumed_at IS NULL`.
  // No column, constraint or row touched; a DML statement appearing here is the thing to stop on.
  "0035_webauthn_open_ceremony_idx": [
    "015b55c441ab7a9d",   // INDEX webauthn_challenges_open_login_idx — the assertion arm
    "29c58b00898e5acf",   // INDEX webauthn_challenges_open_user_idx — registration and step-up
  ],

  "0103_organizer_kind_mobile": [
    "9ec2aaefd86e558b",   // DROP CONSTRAINT IF EXISTS mailboxes_organized_by_kind_closed
    "273741e8fb25a37c",   // ADD CONSTRAINT … CHECK (… IN (…, 'mobile', 'unknown'))
    "bb7044ab48b1bb30",   // DROP CONSTRAINT IF EXISTS mailboxes_disabled_reason_closed
    "676c1c4a76f76857",   // ADD CONSTRAINT … CHECK (… IN (…, 'organized_elsewhere:mobile', …))
  ],

  // Mail 104 — the VERB behind `takeover_authorized_at`, so the lease's rule 6 can refuse a press
  // that asked to JOIN a mailbox rather than take it. THREE hashes: one additive column and
  // 0102's re-runnable drop-then-add closing it. The column arrives with a DEFAULT, so no row is
  // rewritten; the CHECK cannot fail on a live table because every value is the default.
  "0104_mailbox_takeover_intent": [
    "62aba55b487d8a58",   // ADD COLUMN IF NOT EXISTS takeover_intent text NOT NULL DEFAULT 'join'
    "b0c0b1426e1aadef",   // DROP CONSTRAINT IF EXISTS mailboxes_takeover_intent_closed
    "cc9977759bcaa046",   // ADD CONSTRAINT … CHECK (takeover_intent IN ('join', 'takeover'))
  ],

  // Mail 105 — the fifth `sync_blocked_reason`, so an install whose clock disagrees with its mail
  // server stops reporting itself as a mailbox whose folder could not be read. ONE hash, not two:
  // it is 0102's re-runnable drop-then-add, and the DROP is byte-identical to 0102's own, so it is
  // already exempt under that tag — the exemption set is keyed by CONTENT and a Set holds it once.
  // The ADD carries the whole five-member vocabulary and cannot fail on a live table: no rows are
  // rewritten and no existing value is outside the widened set.
  "0105_sync_blocked_reason_clock_off": [
    "00c9cd0b81327294",   // ADD CONSTRAINT … CHECK (… IN (…, 'clock_off'))
  ],

  /**
   * Mail 106 — ONE statement, and it is DML, which is why it is read harder than a column add.
   *
   * `screening_baseline_at` was stamped only when a consent carried a window, so every door that
   * asked none left it NULL. NULL is not "unanswered": the cutline falls back to
   * `now() - dormancy_days` and slides, which holds an established mailbox’s whole history at the
   * gate. This gives each account with a consented mailbox and no baseline the instant it FIRST
   * agreed, read from its own `mailboxes` rows.
   *
   * Reviewed for this list on the three questions the exemption exists to ask:
   *
   *  · **Nothing is DESTRUCTIVE.** No DROP, no DELETE, no rename. The conflict arm carries
   *    ` WHERE "account_settings"."screening_baseline_at" IS NULL`, so a row that already has a
   *    baseline is untouched and a replay writes nothing — idempotent by the same clause.
   *  · **Nothing widens what a row may hold.** No constraint moves; the column’s type and
   *    nullability are unchanged.
   *  · **The value is READ, never invented.** `MIN(organize_consented_at)` over the account’s own
   *    consented mailboxes is a stamp the database already holds. It is the EARLIEST of them
   *    deliberately: an earlier baseline holds strictly less mail than NULL does, so the
   *    correction can only release mail from the gate, never send more to it. An account that
   *    consented to nothing is not in the SELECT at all and gets no row.
   */
  "0106_screening_baseline_backfill": [
    "6ee12f7b3adcc98f",   // INSERT … SELECT MIN(organize_consented_at) … ON CONFLICT … WHERE baseline IS NULL
  ],

  // Mail 107 — the press that releases mail held at the screening gate behind a rule its owner
  // already wrote. ONE hash: a single nullable column on `rules`, `IF NOT EXISTS` so a desktop
  // engine replaying this journal at every launch runs it twice without failing.
  "0107_release_held_at": [
    "142c81a654c54d19",   // ALTER TABLE rules ADD COLUMN IF NOT EXISTS release_held_at timestamptz
  ],

  // Mail 108 — the sign-out's durable stamp, so a credential write that began before a sign-out
  // cannot seal the password back after it. ONE hash: a single nullable column on `mailboxes`,
  // `IF NOT EXISTS` so a desktop engine replaying this journal at every launch runs it twice
  // without failing. Nothing is destructive, nothing widens what a row may hold, and there is no
  // backfill — NULL is the truth for every existing row: nobody has signed out of it here.
  "0108_mailbox_signed_out_at": [
    "a74849c5c020035c",   // ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS signed_out_at timestamptz
  ],

  // Mail 109 — the one-time gate release's per-account marker, so mail held behind a seeded rule
  // nothing was ever owed for is released once and the sweep never runs again. ONE hash: a single
  // nullable column on `account_settings`, `IF NOT EXISTS` so a desktop engine replaying this
  // journal at every launch runs it twice without failing. Nothing is destructive, nothing widens
  // what a row may hold, and there is no backfill — NULL is the truth for every existing row, and
  // it is what makes the pass pick that account up.
  "0109_gate_release_done_at": [
    "9ef669d01db8cb44",   // ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS gate_release_done_at timestamptz
  ],
  // The resurface time (mail 0110) — one additive nullable TEXT column on `account_settings`,
  // holding `'HH:MM'` in the reader's zone. `IF NOT EXISTS`, so a desktop replaying this journal
  // at every launch runs it twice without failing. ONE hash, and its singleness is the assertion:
  // the statement somebody will be tempted to append is
  // `UPDATE account_settings SET resurface_time = '09:00'` — writing the built-in default into
  // every row, which turns "this account has never chosen" into "this account chose 09:00" and
  // takes the product's ability to move that default later. NULL is the default; a second
  // statement in this file stops the suite instead of shipping that.
  /**
   * CLOUD 0036 — the refund obligation. Ten statements, named one by one, so an eleventh appended
   * to this file stops the suite: the whole point of a per-STATEMENT exemption is that a
   * destructive DML line added to an already-exempted migration is not invisible. There is no DML
   * here and there can be none — the table is created empty and nothing is backfilled into it,
   * because a debt is something a REQUEST observed and not something a migration can infer.
   */
  "0036_refund_obligations": [
    "c1b57dd13081fc01",   // CREATE TABLE credit_refund_obligations (account_id FK ON DELETE CASCADE)
    "a49ffedb7e3e4891",   // DROP CONSTRAINT IF EXISTS …_attempt_unique   (the re-runnable half)
    "fc8905507f3388f7",   // ADD  CONSTRAINT …_attempt_unique UNIQUE (account_id, attempt)
    "b660b2f8730e176e",   // DROP CONSTRAINT IF EXISTS …_reason_check
    "3cd7a3299322e44f",   // ADD  CONSTRAINT …_reason_check   CHECK (reason IN (three members))
    "0ff66ebca7aaf513",   // DROP CONSTRAINT IF EXISTS …_len_check
    "dafff22fa7bec902",   // ADD  CONSTRAINT …_len_check      the four text ceilings
    "c8607a05620be012",   // DROP CONSTRAINT IF EXISTS …_tries_check
    "87e56a757fe40033",   // ADD  CONSTRAINT …_tries_check    CHECK (tries >= 0)
    "4da420a94dac6f5c",   // INDEX …_pending_idx (settled_at, owed_at) — the drain's own read
  ],

  "0110_resurface_time": [
    "9010e91e8a204bf7",   // ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS resurface_time text
  ],

  // MAIL 0111 — one nullable column on `mailboxes`, the MAILBOX erasure fence's stamp. Additive,
  // `IF NOT EXISTS`, no default and no backfill, so a device replaying this journal at every
  // launch runs it twice without effect. ONE hash, and its singleness is the assertion: the
  // statement somebody will be tempted to append is a backfill stamping every already-removed
  // mailbox, which would refuse writes against mailboxes whose mail is still there — the column
  // means "this mailbox's mirror was erased", and only the sweep may say that.
  "0111_mailbox_erased_at": [
    "4ee162ca259aa584",   // ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS erased_at timestamptz
  ],

  // When an erasure replaced an idempotency row's stored response (mail 0112) — one additive
  // nullable timestamptz on `idempotency_keys`. `IF NOT EXISTS`, so a desktop replaying this
  // journal at every launch runs it twice without failing. ONE hash, and its singleness is the
  // assertion here too: the statement somebody will be tempted to append is a DELETE of the rows
  // whose content was erased, which would let a retry re-apply its mutation — the one thing the
  // key exists to prevent. The stamp is the answer; a second statement in this file stops the
  // suite instead of shipping that.
  "0112_idempotency_erased_at": [
    "9da843492cb9d4be",   // ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS erased_at timestamptz
  ],

  // Which attempt consumed a refresh token (mail 0113) — one additive nullable TEXT column on
  // `refresh_tokens`, holding sha256 of a client-chosen attempt id. `IF NOT EXISTS`, so a desktop
  // replaying this journal at every launch runs it twice without failing. ONE hash, and its
  // singleness is the assertion: the statement somebody will be tempted to append is a backfill
  // of the rows already consumed — writing an attempt name onto rotations that named none, which
  // would hand the retry arm to whatever value was chosen and turn "this presentation named no
  // attempt" into a claim about a client that never made one. NULL is the only honest value for
  // every row written before the field; a second statement here stops the suite instead.
  "0113_refresh_consumed_by_attempt": [
    "b3f43449b60cb4e9",   // ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS consumed_by_attempt text
  ],

  // The away responder's rotation stamp (mail 0114) — one additive column on `away_responders`,
  // `IF NOT EXISTS` so a desktop replaying this journal at every launch runs it twice without
  // failing. ONE hash, and unlike its neighbours it is NOT NULL with a DEFAULT: `to_timestamp(0)`
  // is the never-walked sentinel the probe's ORDER BY reads, and nullable would have meant the
  // two stores ordering the same page in opposite directions. The default is what backfills every
  // existing row, so the statement somebody would be tempted to append — an UPDATE writing a
  // starting instant — would put rows BEHIND a page they have never been in; a second statement
  // in this file stops the suite instead of shipping that.
  "0114_away_rotation_stamp": [
    "70f67506355ef28a",   // ALTER TABLE away_responders ADD COLUMN IF NOT EXISTS last_considered_at timestamptz NOT NULL DEFAULT to_timestamp(0)
  ],

  // WHERE A BUDGETED FIRST SYNC STOPPED (mail 0115) — two additive nullable columns on
  // `mailbox_folders`, `IF NOT EXISTS` so a desktop replaying this journal at every launch runs
  // them twice without failing. TWO hashes, and they are two columns rather than one because the
  // stopped folder's CURSOR is deliberately not advanced: the row's own `uidvalidity` is last
  // pass's epoch or NULL, never the one the server stated at the stop, and a uid under the wrong
  // epoch names a different message. A THIRD statement would mean one of these, each of which
  // needs reading: a DEFAULT (there must never be one — a backfilled stop would send every
  // mailbox's next pass to a folder nothing chose), an UPDATE (the same claim as a default,
  // written out), or an index (nothing looks a stop up; it is read with the folder rows a cursor
  // build already selects).
  "0115_first_sync_budget_stop": [
    "c1705f14fd3d2fde",   // ALTER TABLE mailbox_folders ADD COLUMN IF NOT EXISTS budget_stop_uid bigint
    "f2316236cb1bbf37",   // ALTER TABLE mailbox_folders ADD COLUMN IF NOT EXISTS budget_stop_uidvalidity bigint
  ],

  // CLOUD 0036 — the staff console's two security controls. Additive throughout: three nullable
  // columns for an enrolment IN PROGRESS (so beginning one never overwrites the authenticator in
  // use), one session column for the step-up stamp, and one append-only table for the operator
  // recovery. NOTHING here is destructive: the only DML is the `last_twofa_at` backfill from
  // `created_at`, which states what is already true of every existing row (a staff session is
  // only ever minted behind the TOTP wall) and is what lets the column be NOT NULL without
  // collapsing "never proved" into "proved long ago". `IF NOT EXISTS` on every ADD, so a replay
  // is a no-op. A THIRTEENTH hash would mean one of: an UPDATE touching `totp_secret_enc` (a
  // schema change deciding somebody's credential), a DROP of either live column, or a GRANT —
  // the hardening script owns every grant, and one smuggled in here would be invisible to it.
  "0036_staff_step_up_and_pending_totp": [
    "54d84c46b42a5dc7",   // ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS totp_pending_secret_enc text
    "bf39a472f7a3c880",   // ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS totp_pending_key_version integer
    "487642b9ed2893b6",   // ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS totp_pending_started_at timestamptz
    "a0657fb1ebdebaea",   // ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_totp_pending_sealed_together
    "4854c9572e991a0f",   // ALTER TABLE staff_users ADD CONSTRAINT … CHECK ((pending_secret IS NULL) = (pending_version IS NULL))
    "57db47fe23a40175",   // ALTER TABLE staff_sessions ADD COLUMN IF NOT EXISTS last_twofa_at timestamptz
    "055f9e8c0c43cbd4",   // UPDATE staff_sessions SET last_twofa_at = created_at WHERE last_twofa_at IS NULL
    "d261b578c25d6ab2",   // ALTER TABLE staff_sessions ALTER COLUMN last_twofa_at SET NOT NULL
    "a20666d04081257a",   // CREATE TABLE IF NOT EXISTS staff_audit_log (id, staff_user_id, action, actor, note, created_at)
    "423486507addc00b",   // staff_audit_log.staff_user_id → staff_users(id) ON DELETE CASCADE, duplicate_object-guarded
    "400d3e47894f0632",   // CREATE INDEX IF NOT EXISTS staff_audit_log_staff_at_idx (staff_user_id, created_at)
    "a8fe240009f3e3da",   // REVOKE ALL ON staff_audit_log FROM ohmail_admin, guarded on the role existing
  ],
  "0116_unsub_drain_cursor": [
    // MAIL — the unsubscribe drain's two memories and the index over the window it walks. FOUR
    // hashes and a fifth would mean a DATA statement was appended: neither table may be
    // backfilled. `unsubscribe_examined` says the pass has LOOKED at a message, and a backfill
    // would claim looks nobody took — every message it invented would stop being a candidate
    // without ever having been judged. `unsubscribe_drain_state` is a position in a walk, and a
    // seeded one would skip the window ahead of it on the first run after the migration. Both
    // start empty, which is the honest state: nothing looked at yet, start at the head.
    "f48f2126afdef4fa",   // CREATE TABLE IF NOT EXISTS unsubscribe_examined (message_id pk, record_id, account_id, created_at)
    "3b9c36eea63fafd0",   // CREATE INDEX IF NOT EXISTS unsubscribe_examined_record_idx (record_id)
    "b21e26be9b03a6e3",   // CREATE TABLE IF NOT EXISTS unsubscribe_drain_state (pass pk, cursor_at, cursor_message_id, updated_at, CHECK the pair is whole)
    "6d3e69440b9b9278",   // CREATE INDEX IF NOT EXISTS folder_state_desired_updated_idx (desired_folder, updated_at, message_id)
  ],
  "0117_junk_rescues": [
    // MAIL — "not junk" becomes a COMMAND the organizer executes, so the API stops opening IMAP to
    // apply it — the rule's one open instance. `folder_state` cannot carry the move:
    // it is `messages`-row-bound and Junk never enters the mirror (FOLDERS-SPEC.md §16.2), so the
    // ordinary case — a message the mail server's own filter filed — has no row to hang it on.
    // The command is a COORDINATE instead, on `folder_ops`' precedent and `message_failures`'
    // locator shape.
    //
    // FOUR hashes, and a FIFTH would mean one of these, each of which needs reading:
    //
    //  · **a DATA statement was appended.** There must never be one. Every row here is a command
    //    somebody pressed for, and the only writer is the route that records the press; a backfill
    //    would be this server inventing moves in a person's mailbox.
    //  · **the status CHECK was widened.** Two members is the design — a LANDED rescue deletes its
    //    row, so there is no third state — and `closed-sets.ts` records it IMMUTABLE, which is what
    //    lets the device store carry the same CHECK. A third member has to be argued there first.
    //  · **the UNIQUE lost a column.** All four are the identity: a UID means nothing outside its
    //    UIDVALIDITY, and dropping `folder` would let a rescue in one folder collide with another.
    //  · **the partial index lost its predicate.** Without it every cycle walks the mailbox's whole
    //    refused history to find what is outstanding.
    "e76d17e8c07fd244",   // CREATE TABLE IF NOT EXISTS junk_rescues (coordinates + status + backoff)
    "107fbef74c9cf9ea",   // DROP CONSTRAINT IF EXISTS junk_rescues_locator_uq — the re-runnable shape
    "6d9ab7b3606864ce",   // UNIQUE (mailbox_id, folder, uidvalidity, uid) — one command per locator
    "37b029646a2bf6b5",   // INDEX (mailbox_id, next_attempt_at) WHERE status = 'pending' — the due probe
  ],
  /**
   * MAIL — the composite account keys, and every statement is idempotent because this journal
   * is replayed: fourteen unique indexes with IF NOT EXISTS, then per reference a DROP IF
   * EXISTS of the single-column key it subsumes, a DROP IF EXISTS of the composite one and the
   * ADD that re-states it, so a replay lays down the definition rather than trusting the name.
   * 117 = 14 indexes + 64 drops + 36 keys + the away ledger's nullability drop + the two
   * UPDATEs that null `message_id` where the message is gone (ADD CONSTRAINT fails on an
   * existing violation; the row keeps its `sender`). A key without its drops is guarded twice,
   * a drop without its key is unguarded, and a bare CREATE or DROP makes the replay refuse.
   */
  "0118_account_isolation": [
    "360b4317a9b6d222",   // CREATE UNIQUE INDEX IF NOT EXISTS "mailboxes_id_account_uq" ON "mailboxes" ("id", "account_id");
    "c800a1d8f9ad908e",   // CREATE UNIQUE INDEX IF NOT EXISTS "messages_id_account_uq" ON "messages" ("id", "account_id");
    "99532bbd0c7a6f8a",   // CREATE UNIQUE INDEX IF NOT EXISTS "threads_id_account_uq" ON "threads" ("id", "account_id");
    "fc77762a36e5a537",   // CREATE UNIQUE INDEX IF NOT EXISTS "contacts_id_account_uq" ON "contacts" ("id", "account_id");
    "412e9321e43d7a6f",   // CREATE UNIQUE INDEX IF NOT EXISTS "tags_id_account_uq" ON "tags" ("id", "account_id");
    "83187ee5f1dfe96f",   // CREATE UNIQUE INDEX IF NOT EXISTS "drafts_id_account_uq" ON "drafts" ("id", "account_id");
    "19c84c40ac70a11e",   // CREATE UNIQUE INDEX IF NOT EXISTS "outbound_sends_id_account_uq" ON "outbound_sends" ("id", "account_id");
    "782b719aaa6b6cac",   // CREATE UNIQUE INDEX IF NOT EXISTS "routing_decisions_id_account_uq" ON "routing_decisions" ("id", "account_id"
    "b0dd9c8cd0ebefe7",   // CREATE UNIQUE INDEX IF NOT EXISTS "rules_id_account_uq" ON "rules" ("id", "account_id");
    "47422379f61b692d",   // CREATE UNIQUE INDEX IF NOT EXISTS "workflows_id_account_uq" ON "workflows" ("id", "account_id");
    "90f9e08b4c1a7502",   // CREATE UNIQUE INDEX IF NOT EXISTS "users_id_account_uq" ON "users" ("id", "account_id");
    "66a16ce99484dbbf",   // CREATE UNIQUE INDEX IF NOT EXISTS "devices_id_account_uq" ON "devices" ("id", "account_id");
    "cfd9d60e46fb3674",   // CREATE UNIQUE INDEX IF NOT EXISTS "sessions_id_account_uq" ON "sessions" ("id", "account_id");
    "12f443d3bd5b3ca7",   // CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_folders_id_mailbox_uq" ON "mailbox_folders" ("id", "mailbox_id");
    "ddde645c9b01d8ef",   // ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_mailbox_id_mailboxes_id_fk";
    "a7917141f3c4a783",   // ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_mailbox_id_account_fk";
    "afcc86d4e76ec9a7",   // ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account_id"
    "13d482ace0045247",   // ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_thread_id_threads_id_fk";
    "3e53d07292992bb1",   // ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_thread_id_account_fk";
    "f18539f55962e4a2",   // ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_account_fk" FOREIGN KEY ("thread_id", "account_id") 
    "59f9deef29279335",   // ALTER TABLE "message_instances" DROP CONSTRAINT IF EXISTS "message_instances_mailbox_id_mailboxes_id_fk";
    "11c16f21d76b423e",   // ALTER TABLE "message_instances" DROP CONSTRAINT IF EXISTS "message_instances_mailbox_id_account_fk";
    "634cc98fe593ac11",   // ALTER TABLE "message_instances" ADD CONSTRAINT "message_instances_mailbox_id_account_fk" FOREIGN KEY ("mailbox
    "80bee2198b26c92b",   // ALTER TABLE "message_instances" DROP CONSTRAINT IF EXISTS "message_instances_message_id_messages_id_fk";
    "4b179f6b9aa0ad4b",   // ALTER TABLE "message_instances" DROP CONSTRAINT IF EXISTS "message_instances_message_id_account_fk";
    "e79c60b5f832feca",   // ALTER TABLE "message_instances" ADD CONSTRAINT "message_instances_message_id_account_fk" FOREIGN KEY ("message
    "81832c5fcafae323",   // ALTER TABLE "message_failures" DROP CONSTRAINT IF EXISTS "message_failures_mailbox_id_mailboxes_id_fk";
    "4f102f032330289c",   // ALTER TABLE "message_failures" DROP CONSTRAINT IF EXISTS "message_failures_mailbox_id_account_fk";
    "fc60c919aa8bbf30",   // ALTER TABLE "message_failures" ADD CONSTRAINT "message_failures_mailbox_id_account_fk" FOREIGN KEY ("mailbox_i
    "c50be6b69f38a906",   // ALTER TABLE "folder_ops" DROP CONSTRAINT IF EXISTS "folder_ops_mailbox_id_mailboxes_id_fk";
    "31104a160e3b6221",   // ALTER TABLE "folder_ops" DROP CONSTRAINT IF EXISTS "folder_ops_mailbox_id_account_fk";
    "e04a54f9eb220fac",   // ALTER TABLE "folder_ops" ADD CONSTRAINT "folder_ops_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account
    "db14e1088de8796b",   // ALTER TABLE "folder_ops" DROP CONSTRAINT IF EXISTS "folder_ops_folder_id_mailbox_folders_id_fk";
    "2e62133300f99587",   // ALTER TABLE "folder_ops" DROP CONSTRAINT IF EXISTS "folder_ops_folder_id_mailbox_fk";
    "d460e4817c00c541",   // ALTER TABLE "folder_ops" ADD CONSTRAINT "folder_ops_folder_id_mailbox_fk" FOREIGN KEY ("folder_id", "mailbox_i
    "a498327a3616fa1a",   // ALTER TABLE "routing_decisions" DROP CONSTRAINT IF EXISTS "routing_decisions_message_id_messages_id_fk";
    "144d62f1b6fb2e3b",   // ALTER TABLE "routing_decisions" DROP CONSTRAINT IF EXISTS "routing_decisions_message_id_account_fk";
    "9b94730ee61a8e99",   // ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_message_id_account_fk" FOREIGN KEY ("message
    "3122b404cb2bfe24",   // ALTER TABLE "routing_decisions" DROP CONSTRAINT IF EXISTS "routing_decisions_matched_rule_id_account_fk";
    "97223d5987eff2b1",   // ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_matched_rule_id_account_fk" FOREIGN KEY ("ma
    "19b1761c9305cafc",   // ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_message_id_account_fk";
    "6f29e736b2f40bc8",   // ALTER TABLE "approvals" ADD CONSTRAINT "approvals_message_id_account_fk" FOREIGN KEY ("message_id", "account_i
    "6f22fc35764d4074",   // ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_routing_decision_id_account_fk";
    "75cc1214644031f1",   // ALTER TABLE "approvals" ADD CONSTRAINT "approvals_routing_decision_id_account_fk" FOREIGN KEY ("routing_decisi
    "3b6589151eebfa80",   // ALTER TABLE "message_states" DROP CONSTRAINT IF EXISTS "message_states_message_id_messages_id_fk";
    "2d285902cc0a9ab3",   // ALTER TABLE "message_states" DROP CONSTRAINT IF EXISTS "message_states_message_id_account_fk";
    "ae240ce2533ab140",   // ALTER TABLE "message_states" ADD CONSTRAINT "message_states_message_id_account_fk" FOREIGN KEY ("message_id", 
    "cc82102d7d31f950",   // ALTER TABLE "tracker_events" DROP CONSTRAINT IF EXISTS "tracker_events_message_id_messages_id_fk";
    "649793b27fa6e003",   // ALTER TABLE "tracker_events" DROP CONSTRAINT IF EXISTS "tracker_events_message_id_account_fk";
    "c736fdc0734b2156",   // ALTER TABLE "tracker_events" ADD CONSTRAINT "tracker_events_message_id_account_fk" FOREIGN KEY ("message_id", 
    "9b6e2f6073b55257",   // ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_message_id_messages_id_fk";
    "c4f022c57e23dd2a",   // ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_message_id_account_fk";
    "97a215b3fa1e9358",   // ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_account_fk" FOREIGN KEY ("message_id", "accou
    "8c3c20d38370f12b",   // ALTER TABLE "message_tags" DROP CONSTRAINT IF EXISTS "message_tags_message_id_messages_id_fk";
    "a28ac8f530ed5a0a",   // ALTER TABLE "message_tags" DROP CONSTRAINT IF EXISTS "message_tags_message_id_account_fk";
    "9a3c7d2dad847010",   // ALTER TABLE "message_tags" ADD CONSTRAINT "message_tags_message_id_account_fk" FOREIGN KEY ("message_id", "acc
    "9e9f488f5b847718",   // ALTER TABLE "message_tags" DROP CONSTRAINT IF EXISTS "message_tags_tag_id_tags_id_fk";
    "718461fea9d43279",   // ALTER TABLE "message_tags" DROP CONSTRAINT IF EXISTS "message_tags_tag_id_account_fk";
    "c230a0dd8c6169d5",   // ALTER TABLE "message_tags" ADD CONSTRAINT "message_tags_tag_id_account_fk" FOREIGN KEY ("tag_id", "account_id"
    "d7f355e7e1020e11",   // ALTER TABLE "unsubscribe_records" DROP CONSTRAINT IF EXISTS "unsubscribe_records_mailbox_id_mailboxes_id_fk";
    "aabc75ca5ba0304c",   // ALTER TABLE "unsubscribe_records" DROP CONSTRAINT IF EXISTS "unsubscribe_records_mailbox_id_account_fk";
    "cfa57cd89e7b061f",   // ALTER TABLE "unsubscribe_records" ADD CONSTRAINT "unsubscribe_records_mailbox_id_account_fk" FOREIGN KEY ("mai
    "e7890b2008671787",   // ALTER TABLE "unsubscribe_records" DROP CONSTRAINT IF EXISTS "unsubscribe_records_message_id_messages_id_fk";
    "3d7f186c02b71b53",   // ALTER TABLE "unsubscribe_records" DROP CONSTRAINT IF EXISTS "unsubscribe_records_message_id_account_fk";
    "7303880c9dd1a5b4",   // ALTER TABLE "unsubscribe_records" ADD CONSTRAINT "unsubscribe_records_message_id_account_fk" FOREIGN KEY ("mes
    "e153bb124f903db4",   // ALTER TABLE "contact_notes" DROP CONSTRAINT IF EXISTS "contact_notes_contact_id_contacts_id_fk";
    "ac6062abd7c04b6f",   // ALTER TABLE "contact_notes" DROP CONSTRAINT IF EXISTS "contact_notes_contact_id_account_fk";
    "a447a1e32718c608",   // ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_id_account_fk" FOREIGN KEY ("contact_id", "a
    "69854491e05a37c5",   // ALTER TABLE "thread_notes" DROP CONSTRAINT IF EXISTS "thread_notes_thread_id_threads_id_fk";
    "123c335942279a59",   // ALTER TABLE "thread_notes" DROP CONSTRAINT IF EXISTS "thread_notes_thread_id_account_fk";
    "47a8be743b27b0d3",   // ALTER TABLE "thread_notes" ADD CONSTRAINT "thread_notes_thread_id_account_fk" FOREIGN KEY ("thread_id", "accou
    "3a277c386d0ad0c1",   // ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_mailbox_id_mailboxes_id_fk";
    "32f0c763fafe772e",   // ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_mailbox_id_account_fk";
    "ec51de5a05e244fc",   // ALTER TABLE "drafts" ADD CONSTRAINT "drafts_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "account_id") RE
    "4c5d7dd1fc8151eb",   // ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_thread_id_threads_id_fk";
    "5c1ef972db261e4d",   // ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_thread_id_account_fk";
    "294067bf4ef2aef6",   // ALTER TABLE "drafts" ADD CONSTRAINT "drafts_thread_id_account_fk" FOREIGN KEY ("thread_id", "account_id") REFE
    "dc1d537c820d8159",   // ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_in_reply_to_message_id_messages_id_fk";
    "f7e28b78baefb71b",   // ALTER TABLE "drafts" DROP CONSTRAINT IF EXISTS "drafts_in_reply_to_message_id_account_fk";
    "f1226391115c27e0",   // ALTER TABLE "drafts" ADD CONSTRAINT "drafts_in_reply_to_message_id_account_fk" FOREIGN KEY ("in_reply_to_messa
    "5876ed471160e5d4",   // ALTER TABLE "outbound_sends" DROP CONSTRAINT IF EXISTS "outbound_sends_draft_id_drafts_id_fk";
    "f99b907943f46378",   // ALTER TABLE "outbound_sends" DROP CONSTRAINT IF EXISTS "outbound_sends_draft_id_account_fk";
    "12186e548328e175",   // ALTER TABLE "outbound_sends" ADD CONSTRAINT "outbound_sends_draft_id_account_fk" FOREIGN KEY ("draft_id", "acc
    "4fe485b302c79132",   // ALTER TABLE "outbound_send_fingerprints" DROP CONSTRAINT IF EXISTS "outbound_send_fingerprints_send_id_fkey";
    "724859f17f38a9ba",   // ALTER TABLE "outbound_send_fingerprints" DROP CONSTRAINT IF EXISTS "outbound_send_fingerprints_send_id_account
    "09376eaa061652ef",   // ALTER TABLE "outbound_send_fingerprints" ADD CONSTRAINT "outbound_send_fingerprints_send_id_account_fk" FOREIG
    "2caa0683800a0721",   // ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_workflow_id_workflows_id_fk";
    "fc28e1f66fb16e93",   // ALTER TABLE "workflow_runs" DROP CONSTRAINT IF EXISTS "workflow_runs_workflow_id_account_fk";
    "f24518d29f1c7a91",   // ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_account_fk" FOREIGN KEY ("workflow_id", 
    "cd235f5489e7062d",   // ALTER TABLE "away_replies" DROP CONSTRAINT IF EXISTS "away_replies_mailbox_id_account_fk";
    "0f944a449ed68ff8",   // ALTER TABLE "away_replies" ADD CONSTRAINT "away_replies_mailbox_id_account_fk" FOREIGN KEY ("mailbox_id", "acc
    "3923946a88be4d97",   // ALTER TABLE "away_replies" ALTER COLUMN "message_id" DROP NOT NULL;
    "28356018846f2b81",   // UPDATE "away_replies" SET "message_id" = NULL WHERE NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = "awa
    "6efb5177aacae433",   // ALTER TABLE "away_replies" DROP CONSTRAINT IF EXISTS "away_replies_message_id_account_fk";
    "12c5abb3565fac42",   // ALTER TABLE "away_replies" ADD CONSTRAINT "away_replies_message_id_account_fk" FOREIGN KEY ("message_id", "acc
    "4053f0131f8cf29a",   // UPDATE "away_responder_sent" SET "message_id" = NULL WHERE "message_id" IS NOT NULL AND NOT EXISTS (SELECT 1 F
    "3f26404ae8769ed9",   // ALTER TABLE "away_responder_sent" DROP CONSTRAINT IF EXISTS "away_responder_sent_message_id_account_fk";
    "485376cfd33e42cf",   // ALTER TABLE "away_responder_sent" ADD CONSTRAINT "away_responder_sent_message_id_account_fk" FOREIGN KEY ("mes
    "4d7a9a3e8b7486bd",   // ALTER TABLE "organizer_requests" DROP CONSTRAINT IF EXISTS "organizer_requests_mailbox_id_account_fk";
    "fce70dea9cd854fc",   // ALTER TABLE "organizer_requests" ADD CONSTRAINT "organizer_requests_mailbox_id_account_fk" FOREIGN KEY ("mailb
    "dc95e33889bcd01d",   // ALTER TABLE "mailbox_profile_mirror" DROP CONSTRAINT IF EXISTS "mailbox_profile_mirror_mailbox_id_account_fk";
    "fb45503ade8870e8",   // ALTER TABLE "mailbox_profile_mirror" ADD CONSTRAINT "mailbox_profile_mirror_mailbox_id_account_fk" FOREIGN KEY
    "2f189cf7af88c3dc",   // ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "devices_user_id_users_id_fk";
    "738fe8291aeb1fb2",   // ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "devices_user_id_account_fk";
    "43014f27652c6787",   // ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_account_fk" FOREIGN KEY ("user_id", "account_id") REFERE
    "2a6b83d46570fa2b",   // ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_user_id_users_id_fk";
    "f51dd48c87189af2",   // ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_user_id_account_fk";
    "23b85e3f8fb86eba",   // ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_account_fk" FOREIGN KEY ("user_id", "account_id") REFE
    "5e5222208e060ee4",   // ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_device_id_devices_id_fk";
    "379ba92062d9c377",   // ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_device_id_account_fk";
    "ec964b68994bd179",   // ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_account_fk" FOREIGN KEY ("device_id", "account_id") 
    "02623e90e4d3cc26",   // ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_user_id_users_id_fk";
    "8ac25a9a714c3417",   // ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_user_id_account_fk";
    "cb4cc9e980ed3f83",   // ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_account_fk" FOREIGN KEY ("user_id", "accou
    "230411562e8f52ca",   // ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_session_id_sessions_id_fk";
    "ccaf286c0c86f45b",   // ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_session_id_account_fk";
    "36eeb665c670a760",   // ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_account_fk" FOREIGN KEY ("session_id", 
  ],
  /**
   * CLOUD — the same keys on the identity half, and the four UPDATEs that make them appliable.
   * An erasure leaves audit rows naming a parent that is gone, and a key cannot be added over
   * one; the rows survive with their ids nulled. `push_subscriptions` joined them because its
   * `device_id` is whatever the registering request sent, so one row naming no device of its
   * account aborted the whole cloud pass. The UPDATEs are the one place a data statement belongs
   * under this family, they are idempotent and `NOT EXISTS`-scoped, and an EIGHTH hash would mean
   * either another of them or a key nobody has read.
   */
  "0038_account_isolation": [
    "ff7c3171e1e6aee4",   // UPDATE "auth_events" SET "user_id" = NULL WHERE "user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 F
    "c365615438327473",   // UPDATE "auth_events" SET "account_id" = NULL WHERE "account_id" IS NOT NULL AND NOT EXISTS (SELE
    "8e42b720c76fd4da",   // UPDATE "webauthn_challenges" SET "user_id" = NULL WHERE "user_id" IS NOT NULL AND NOT EXISTS (SE
    "0c043659a1c3ab08",   // UPDATE "push_subscriptions" SET "device_id" = NULL WHERE "device_id" IS NOT NULL AND NOT EXIST
    // Each key is DROPPED before it is added — the flat replayable form mail 0118 already
    // carries, added when the replay census read this entry refusing its own second application.
    "efd7af1f5230fedc",   // ALTER TABLE "webauthn_challenges" DROP CONSTRAINT IF EXISTS "webauthn_challenges_user_id_users_id
    "e4f73980c7ef4c6e",   // ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREI
    "8de89302dc8f9880",   // ALTER TABLE "push_subscriptions" DROP CONSTRAINT IF EXISTS "push_subscriptions_device_id_account_
    "cce50942dab57d7e",   // ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_device_id_account_fk" FOREIG
    "f551ee4e2d12773a",   // ALTER TABLE "auth_events" DROP CONSTRAINT IF EXISTS "auth_events_user_id_account_fk";
    "fd01c6193cb4324f",   // ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_id_account_fk" FOREIGN KEY ("user_id"
  ],
  // MAIL 0119 — the honest arrival the Ohbox's sort clamp keys on (`messages.arrived_at`,
  // nullable, no backfill). One additive statement, post-split by construction.
  "0119_messages_arrived_at": [
    "c6e1f7c243d57609",   // ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "arrived_at" timestamp with time zone;
  ],

  // Mail 0120 — the dismissed held-release offer's fingerprint (FIX-021). THREE hashes: one
  // additive nullable text column, `IF NOT EXISTS` so a desktop engine replaying this journal at
  // every launch runs it twice without failing, and a length CHECK that cannot fail on a live
  // table because every existing value is NULL — preceded by its own `DROP CONSTRAINT IF EXISTS`,
  // because Postgres has no `ADD CONSTRAINT IF NOT EXISTS` and the bare ADD refused the second
  // pass. Nothing destructive, no DML, no backfill — NULL is the truth for every existing row:
  // nobody has dismissed anything yet.
  "0120_held_release_dismissed": [
    "96d438e7056b2b33",   // ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS held_release_dismissed text
    "3224e0c93e5169ac",   // DROP CONSTRAINT IF EXISTS account_settings_held_release_dismissed_len (re-runnable pair)
    "fd7770bbff3bcb6a",   // ADD CONSTRAINT account_settings_held_release_dismissed_len CHECK (char_length <= 128)
  ],

  // MAIL 0121 — why a standing stop has not finished (mail 0121): the sibling-lapse discriminator on
  // `mailboxes` (`release_refusal`, nullable text, no backfill). One additive statement.
  "0121_release_refusal": [
    "255cd6de18d0875b",   // ALTER TABLE "mailboxes" ADD COLUMN IF NOT EXISTS "release_refusal" text;
  ],
  /**
   * CLOUD 0039 — the suggest-owed mark. ONE statement, and its singleness is the review: a
   * `CREATE TABLE IF NOT EXISTS` with two columns (an account FK `ON DELETE CASCADE` and an
   * arrival instant), created EMPTY. No DML and there can be none — a mark is something INGEST
   * observed, never something a migration can infer, and a backfill here would put every
   * opted-in account at the front of the first post-deploy cycle for no hold anybody saw.
   * Nothing destructive, nothing that can fail on a live table.
   */
  "0039_screener_suggest_owed": [
    "df3939a034818fb9",   // CREATE TABLE IF NOT EXISTS screener_suggest_owed (account_id FK CASCADE, owed_at)
  ],
  /**
   * CLOUD 0040 — the wall's notice ledger. ONE statement, and its singleness is the review: a
   * `CREATE TABLE IF NOT EXISTS` with four columns, an FK `ON DELETE CASCADE`, the composite PK
   * that IS the idempotency, and the kind CHECK — created EMPTY. No DML and there can be none: a
   * notice is something the pass SENT, never something a migration can infer, and a backfill
   * here would either re-mail every closed account or silently mark mails sent that never were.
   * Nothing destructive, nothing that can fail on a live table.
   */
  "0040_account_lifecycle_notices": [
    "8da39579351b1d03",   // CREATE TABLE IF NOT EXISTS account_lifecycle_notices (PK account,kind,anchor; kind CHECK)
  ],
  // MAIL 0122 — change-log retention: the explicit 410 floor the sync route reads and the
  // retention pass raises. ONE additive statement, `IF NOT EXISTS`, nothing destructive, nothing
  // that can fail on a live table. The prune's index is not here: an index build on a growth
  // table is a `ConcurrentIndexSpec` (`hot-path-indexes.ts`), never a journal statement.
  "0122_change_log_retention": [
    "116ef5d456a2a740",   // ALTER TABLE "account_sync_state" ADD COLUMN IF NOT EXISTS "pruned_through_seq" bigint NOT NULL
  ],
  // MAIL 0123 — `ohmail/News` joins the away scope (the 0.22 folder rename). The CHECK is
  // REPLACED under its name, 0101's shape one member on: widened, never narrowed, the legacy
  // member kept for rows written before the rename. No DML — a rewrite would stop an older
  // engine answering its own stored spelling. The DROP normalises to 0096's exempted statement.
  "0123_news_pile_check": [
    "a343839c7f94409d",   // ALTER TABLE "away_responders" ADD CONSTRAINT "away_responders_piles_closed" CHECK (piles <@ … five members incl. ohmail/News)
  ],
  // MAIL 0124 — the sixth `sync_blocked_reason`, so a parked account's mailbox says WHY it is not
  // syncing (`account_closed`, the wall) instead of reading as an ordinary connected mailbox.
  // Mail 0105's shape verbatim: drop-then-add, idempotent under the desktop's replay; the DROP
  // normalizes to 0102's own statement, so only the widened ADD is new. Nothing destructive —
  // the widening ADMITS one more value and refuses nothing a live table can hold.
  "0124_sync_blocked_reason_account_closed": [
    "6f2de3de309aff74",   // DROP CONSTRAINT IF EXISTS mailboxes_sync_blocked_reason_closed (0102's own text)
    "967d36b08e24d135",   // ADD CONSTRAINT … CHECK (six members, + 'account_closed')
  ],
  // MAIL 0125 — the search document: a NEW table with its three indexes (built on an empty table,
  // so free), the History index in 0071's shape (prebuilt concurrently ahead of the migrator, so
  // this no-ops wherever mail lives), and the backfill's completion stamp. Additive throughout.
  "0125_message_search": [
    "e739ccaf92bf21ec",   // CREATE TABLE IF NOT EXISTS "message_search" (… composite account key …)
    "eec708fb46abad82",   // CREATE INDEX IF NOT EXISTS message_search_head_tsv_idx … gin (head_tsv)
    "3a55b35628645077",   // CREATE INDEX IF NOT EXISTS message_search_text_tsv_idx … gin (text_tsv)
    "d2194c380e1d370c",   // CREATE INDEX IF NOT EXISTS message_search_account_idx (account_id, message_id)
    "5dc74fcf6d22332a",   // create index if not exists messages_account_msg_order_idx (the hot-path spelling)
    "2ef01518dd4c2f9c",   // ADD COLUMN IF NOT EXISTS account_settings.search_index_built_at
  ],
  // MAIL 0126 — when a mailbox's erasure finished, beside 0111's stamp: the request stamps, the
  // worker's pass sweeps in steps, and this column is the pass's resume point. Additive, `IF NOT
  // EXISTS`; the backfill marks every older stamp done (those were one-transaction sweeps); the
  // index is partial over the owed pairs, which are few by construction.
  "0126_mailbox_erasure_done": [
    "3edda63b0f7eec09",   // ADD COLUMN IF NOT EXISTS "erasure_done_at" timestamptz
    "6906327d72996bb1",   // UPDATE … SET erasure_done_at = erased_at WHERE stamped and unset
    "4bd60c00bf55e211",   // CREATE INDEX IF NOT EXISTS mailboxes_erasure_owed_idx … WHERE owed
  ],
  // MAIL 0127 — where a signed-out mailbox lives, beside 0108's stamp: the sign-out keeps the
  // non-secret half of the credential rows it removes. One additive nullable column, `IF NOT
  // EXISTS`, no backfill and no DML.
  "0127_mailbox_signed_out_meta": [
    "f9318d3096f2f44f",   // ADD COLUMN IF NOT EXISTS "signed_out_meta" jsonb
  ],
  // MAIL 0128 — who made a rule's decision: the automatic unsubscribe pass acts only for a sender
  // a person-decided rule screens out. One additive nullable column, `IF NOT EXISTS`, no DML.
  "0128_rule_person_decided": [
    "96ba729629d17d55",   // ADD COLUMN IF NOT EXISTS "person_decided_at" timestamptz
  ],
  // MAIL 0129 — a press of Import settings the organizer finishes: four additive nullable columns
  // on `mailboxes`, `IF NOT EXISTS`, no backfill and no DML. The number is provisional until the
  // migration is released.
  "0129_profile_import_ask": [
    "af9c4ef725d990ae",   // ADD COLUMN IF NOT EXISTS "profile_import_ask_fingerprint" text
    "8a2856261beb2a5a",   // ADD COLUMN IF NOT EXISTS "profile_import_ask_at" timestamptz
    "6c20a1d3bd2b5895",   // ADD COLUMN IF NOT EXISTS "profile_import_ask_outcome" text
    "e8c64d304c6dca5c",   // ADD COLUMN IF NOT EXISTS "profile_import_ask_reason" text
  ],
  // MAIL 0130 — a provider's "not now" is the seventh `sync_blocked_reason`, and a first import
  // that hits one of our ceilings stamps `sync_progress_at` for the lag alert. 0124's shape for
  // the CHECK (the DROP normalises to 0102's statement), one additive nullable column, and a
  // grant guarded on the staff role existing (0067's shape). Nothing destructive.
  "0130_mailbox_sync_soft_states": [
    "a4f10f1c94606227",   // ADD CONSTRAINT … CHECK (seven members, + 'provider_unavailable')
    "5249e5d9fb5ddc32",   // ADD COLUMN IF NOT EXISTS "sync_progress_at" timestamptz
    "da0aa421b684c81d",   // DO $$ … GRANT SELECT ("sync_progress_at") … TO "ohmail_admin" (guarded)
  ],
  // MAIL 0131 — the four uid columns to bigint, so a UID above 2^31 is storable. Four type
  // changes and nothing else: no USING, no DML. Each rewrites its table under ACCESS EXCLUSIVE.
  "0131_uid_bigint": [
    "37feed8ea1e24a87",   // message_instances.uid TYPE bigint
    "a26b125344460b49",   // message_failures.uid TYPE bigint
    "acbb5c843a4ad83f",   // junk_rescues.uid TYPE bigint
    "9213a5777ce3030c",   // mailbox_profile_mirror.uid TYPE bigint
  ],
  // MAIL 0132 — the mailbox's own Sent folder, written at attach beside 0065's Junk and Trash and
  // read by correspondent knowledge. One additive nullable column, `IF NOT EXISTS`, no DML.
  "0132_mailbox_sent_folder": [
    "92d4c3de6ad3808a",   // ADD COLUMN IF NOT EXISTS "sent_folder" text
  ],
  // MAIL 0133 — the act on suggestions' own consent, and its refusal on the suggestion row. Three
  // additive nullable columns, `IF NOT EXISTS`, and a closed CHECK, drop-then-add, NOT VALID. No DML.
  "0133_screener_auto_act": [
    "a08b73f5cd9ccab5",   // account_settings ADD COLUMN IF NOT EXISTS "screener_auto_act_at" timestamptz
    "c8ffa917999dd14c",   // routing_decisions ADD COLUMN IF NOT EXISTS "act_refused_at" timestamptz
    "51432417cc879f17",   // routing_decisions ADD COLUMN IF NOT EXISTS "act_refusal" text
    "f870b46ddeaeb50a",   // DROP CONSTRAINT IF EXISTS routing_decisions_act_refusal_closed
    "b9a03926b48d84cd",   // ADD CONSTRAINT … CHECK (act_refusal in the four refusals) NOT VALID
  ],
  // MAIL 0134 — `too_large` joins the withheld reasons: a message over the download ceiling is a
  // header-only row. 0065's drop-then-add; the DROP normalises to 0062's exempted statement, so only
  // the widened ADD is new, NOT VALID and never validated in the pass. No DML.
  "0134_withheld_too_large": [
    "d33cbb4f85bc87c8",   // ADD CONSTRAINT message_bodies_withheld_reason CHECK (… + 'too_large') NOT VALID
  ],
  // MAIL 0135 — when the wall released a mailbox. One additive nullable column, `IF NOT EXISTS`,
  // no DML.
  "0135_organizer_parked_at": [
    "b164f66435e95ae6",   // ADD COLUMN IF NOT EXISTS "organizer_parked_at" timestamptz
  ],
  // MAIL 0136 — the Screener auto-apply candidate statement's three per-row probes, each keyed on
  // the account, plain `IF NOT EXISTS` builds on three small tables. No DML.
  "0136_screener_probe_indexes": [
    "0c8754b3f4e420c5",   // CREATE INDEX IF NOT EXISTS rules_account_match_key_idx (account_id, trim(lower(match))) WHERE enabled
    "0196285a74832892",   // CREATE INDEX IF NOT EXISTS approvals_account_message_idx (account_id, message_id) WHERE message_id IS NOT NULL
    "1a95a5deaea5219e",   // CREATE INDEX IF NOT EXISTS drafts_account_reply_idx (account_id, in_reply_to_message_id) WHERE in_reply_to_message_id IS NOT NULL
  ],
  // THE FORWARD COLUMN — the message a draft forwards. One nullable column, its account-scoped key and the
  // reply-or-forward CHECK, each constraint dropped before it is added. No DML.
  "0137_draft_forward_of": [
    "7540151146c825da",   // ADD COLUMN IF NOT EXISTS "forward_of_message_id" uuid
    "92a96612b9b62281",   // DROP CONSTRAINT IF EXISTS drafts_forward_of_message_id_account_fk
    "e23867d5607c31fb",   // ADD CONSTRAINT … FOREIGN KEY (forward_of_message_id, account_id) REFERENCES messages
    "54c4e7c6d613e282",   // DROP CONSTRAINT IF EXISTS drafts_reply_xor_forward
    "f0ab8c8cfa335145",   // ADD CONSTRAINT … CHECK (in_reply_to_message_id IS NULL OR forward_of_message_id IS NULL)
  ],
  // THE PUT-BACK COLUMN — the Screener's automatic filing, undone by the person, never filed again.
  // One nullable column, IF NOT EXISTS. No DML.
  "0138_auto_filing_undone_at": [
    "13fae8972e78a253",   // ADD COLUMN IF NOT EXISTS "auto_filing_undone_at" timestamp with time zone
  ],
  // THE ARRIVAL ORDER INDEX — the one every store order of mail walks, prebuilt concurrently by the
  // setup command on 0125's pattern. One statement, no DML.
  "0139_messages_arrival_order": [
    "b960c36aaf2893d3",   // create index if not exists messages_account_arrival_order_idx (the hot-path spelling)
  ],
  // THE BOUNDED BODY VECTOR — `body_tsv` from a generated column to a trigger-kept one over the first
  // stretch of characters, and `data_too_large` among the failure codes. No DML: nothing is rewritten.
  "0140_body_tsv_bounded": [
    "dff6a22649f1c375",   // ALTER COLUMN "body_tsv" DROP EXPRESSION IF EXISTS
    "9d9960767dc3b842",   // CREATE OR REPLACE FUNCTION message_bodies_body_tsv_bounded
    "b0951738adde455f",   // DROP TRIGGER IF EXISTS message_bodies_body_tsv_tg
    "012838601b578773",   // CREATE TRIGGER message_bodies_body_tsv_tg BEFORE INSERT OR UPDATE OF "text"
    "8ed66f5256dad18d",   // DROP CONSTRAINT IF EXISTS message_failures_code_closed
    "dcd4a9f7e6a65cec",   // ADD CONSTRAINT … CHECK (the six failure codes) NOT VALID
  ],
  // THE FLOOR VERDICT — the auto-apply pass's mark on a held row it read with no strong-bulk floor.
  // One nullable column, IF NOT EXISTS. No DML.
  "0141_screener_floor_version": [
    "5fd16d00be38663e",   // ADD COLUMN IF NOT EXISTS "screener_floor_version" integer
  ],
  // THE FULL META FOLDER, NAMED — `meta_folder_full` joins the sync-block reasons. Drop-then-add,
  // 0130's shape; the DROP normalizes to 0102's own statement, so only the widened ADD is new. No DML.
  "0142_sync_blocked_reason_meta_folder_full": [
    "2223c2fd993da035",   // ADD CONSTRAINT … CHECK (eight members, + 'meta_folder_full')
  ],
  // THE UNDELETABLE META FOLDER, NAMED — `meta_undeletable` joins the sync-block reasons. 0142's
  // shape; the DROP normalizes to 0102's own statement, so only the widened ADD is new. No DML.
  "0143_sync_blocked_reason_meta_undeletable": [
    "5ed89a6e84940b54",   // ADD CONSTRAINT … CHECK (nine members, + 'meta_undeletable')
  ],
  // THE PERSON'S DECISIONS BEFORE THEIR STAMP — class C (relabelled `manual` and stamped, skipping a
  // decision INTO INBOX), its second arm (the same row created after the person's newest spam or
  // screen-out, which is newer than ohmail's admit), class A (stamped), then the rules key index,
  // IF NOT EXISTS, last. DML whose WHEREs read the trail as it stands and empty after one run.
  "0144_rule_person_decided_backfill": [
    "1800c3c49c483b93",   // UPDATE rules … class C: provenance 'manual', person_decided_at = created_at
    "9667b902facffa48",   // UPDATE rules … FROM each key's newest spam and admit: class C's second arm
    "986e64a0664f09d2",   // UPDATE rules … class A: person_decided_at = created_at
    "c4048b7ab3f58865",   // CREATE INDEX IF NOT EXISTS "rules_account_key_idx" (account_id, trim(lower(match)))
  ],
  // THE STALE-PRESS STAMP — when a decision about a message's placement, read state or triage was
  // placed: three nullable columns, IF NOT EXISTS, and the request refusals widened by `superseded`
  // (the DROP normalizes to 0094's own statement, so only the widened ADD is new). No DML.
  "0145_press_decided_at": [
    "5f3b6d91ca21cb80",   // ADD COLUMN IF NOT EXISTS folder_state.decided_at
    "309f556294ba7c7c",   // ADD COLUMN IF NOT EXISTS flag_state.decided_at
    "51045540fb1c7dd2",   // ADD COLUMN IF NOT EXISTS message_states.decided_at
    "71f448a32844489c",   // ADD CONSTRAINT … CHECK (twelve refusal words, + 'superseded')
  ],
  // THE STAMPS 0144 COULD NOT GIVE — arm I (an older settings copy's allow, imported after 0144, of a
  // sender this store has as a contact with no Screener signal and no graduated key: stamped, still
  // `promoted`) and arm D (0144's second arm on the whole domain: `manual` and stamped). DML only,
  // whose WHEREs read the trail as it stands and empty after one run.
  "0146_rule_person_decided_followup": [
    "f918bd56dfe1a2a9",   // UPDATE rules … arm I: person_decided_at = created_at
    "6a67ebfe886e0361",   // UPDATE rules … FROM each domain's newest spam: provenance 'manual', stamped
  ],
  // THE OPEN READ — when a message was read in ohmail while it was the open row. One nullable
  // column on `messages`, IF NOT EXISTS. No index, no default, no DML.
  "0147_messages_open_read_at": [
    "8104ef399c8ca735",   // ADD COLUMN IF NOT EXISTS "open_read_at" timestamp with time zone
  ],
  // THE IDENTITY FACT — two nullable columns on messages and one on contacts, IF NOT EXISTS, and
  // the closed set's CHECK in the DO block that catches `duplicate_object`, NOT VALID on a growth
  // table. No DML; the backfill's index is a hot-path spec built CONCURRENTLY outside the journal.
  "0148_messages_sender_check": [
    "4e4249ee5d548087",   // ADD COLUMN IF NOT EXISTS "sender_check" text
    "13e025ba06632560",   // ADD COLUMN IF NOT EXISTS "sender_check_brand" text
    "6e71214e6c36a9ad",   // ADD COLUMN IF NOT EXISTS contacts "source" text
    "77de3209f1defefc",   // DO … ADD CONSTRAINT "messages_sender_check_closed" … NOT VALID
  ],
  // WHICH WRITER GAVE THE FACT — one nullable column on messages, IF NOT EXISTS, and the closed
  // set's CHECK in the DO block that catches `duplicate_object`, NOT VALID on a growth table. No DML.
  "0149_messages_sender_check_by": [
    "dd123f2a89906145",   // ADD COLUMN IF NOT EXISTS "sender_check_by" text
    "f40063396989b185",   // DO … ADD CONSTRAINT "messages_sender_check_by_closed" … NOT VALID
  ],
  // MAIL 0150 — the addresses a mailing list posts as: a NEW table keyed (account_id, address),
  // IF NOT EXISTS, and the backfill's stamp on account_settings, IF NOT EXISTS. No index beyond the
  // key, no DML.
  "0150_list_addresses": [
    "15477fd5a4b03c32",   // CREATE TABLE IF NOT EXISTS "list_addresses" (… composite account key …)
    "9fe3f9cee2b83209",   // ADD COLUMN IF NOT EXISTS account_settings.list_addresses_scanned_at
  ],
  // MAIL 0151 — the gap window and its offer: three nullable columns on mailboxes, IF NOT EXISTS. No index, no DML.
  "0151_mailboxes_gap_since": [
    "9baa3c773a46d928",   // ADD COLUMN IF NOT EXISTS mailboxes.gap_since timestamptz
    "743e9832790a7aee",   // ADD COLUMN IF NOT EXISTS mailboxes.gap_letters integer
    "bf6282d68f95a105",   // ADD COLUMN IF NOT EXISTS mailboxes.gap_pressed_at timestamptz
  ],
  // THE SEARCH GIN PENDING LIST, BOUNDED — storage parameters on message_search's three GIN
  // indexes (IF EXISTS: the trigram one is built outside the journal) and one flush. No DML.
  "0152_search_gin_pending_bounded": [
    "0149e096fe49fc06",   // ALTER INDEX IF EXISTS message_search_head_tsv_idx SET (gin_pending_list_limit = 256)
    "306a14ed00135112",   // ALTER INDEX IF EXISTS message_search_text_tsv_idx SET (…)
    "9ed3582e32f2b346",   // ALTER INDEX IF EXISTS message_search_terms_trgm_idx SET (…)
    "44d0fa615788b8dd",   // SELECT gin_clean_pending_list(…) over the three that exist
  ],
  // THE RULE KEY DROPS ITS POINTER ON A REVOKE — 0118's routing_decisions → rules key recreated
  // under its name with ON DELETE SET NULL ("matched_rule_id"), NOT VALID. No DML.
  "0153_rule_revoke_keeps_its_decisions": [
    "3122b404cb2bfe24",   // ALTER TABLE "routing_decisions" DROP CONSTRAINT IF EXISTS … (0118's own drop, verbatim)
    "8b45247728ca7e65",   // ADD CONSTRAINT routing_decisions_matched_rule_id_account_fk … ON DELETE SET NULL (…) NOT VALID
  ],
  // THE ARCHIVE BY RECIPIENT — an IMMUTABLE function over To and Cc and its GIN expression index,
  // IF NOT EXISTS (setup-prod builds it CONCURRENTLY ahead of the migrator). No column, no DML.
  "0154_messages_recipient_keys": [
    "80532d8274c1dcb7",   // CREATE OR REPLACE FUNCTION messages_recipient_keys(uuid, jsonb, jsonb) … IMMUTABLE
    "c71b7fc976856c1a",   // create index if not exists messages_recipient_keys_idx … using gin (messages_recipient_keys(…))
  ],
  // THE SEND RE-ARM — three columns on outbound_sends, IF NOT EXISTS: an attempt count with a constant
  // default (metadata-only), a nullable deadline and the nullable refusal a late replay is told. No
  // index, no DML.
  "0155_outbound_sends_rearm": [
    "258a4e9532322326",   // ADD COLUMN IF NOT EXISTS outbound_sends.attempts integer NOT NULL DEFAULT 1
    "35f97525eedb4ba5",   // ADD COLUMN IF NOT EXISTS outbound_sends.retry_until timestamptz
    "60e53cf82eaf0be4",   // ADD COLUMN IF NOT EXISTS outbound_sends.retry_refusal text
  ],
  // THE FACT THAT CAPPED A STORED SUGGESTION — one nullable text column on routing_decisions, IF NOT
  // EXISTS: no default, no CHECK, no index, no DML (NULL is a row stored before it).
  "0156_routing_decisions_sender_reason": [
    "62b940f43f03a210",   // ADD COLUMN IF NOT EXISTS routing_decisions.sender_reason text
  ],
  // THE SCREENER CUTLINE PROBE'S INDEX — one btree on messages over the cutline's own key, prebuilt
  // CONCURRENTLY by setup (SENDER_DATE_PREBUILD_SPEC), so this no-ops on a live server. No DML.
  "0157_messages_sender_date": [
    "4075edd93e0d71f6",   // create index if not exists messages_account_sender_date_idx (account_id, lower(from_address), coalesce(date, created_at))
  ],
  // THE GAP OFFER'S STRANGER COUNT — one nullable integer on mailboxes, IF NOT EXISTS: no default,
  // no index, no DML (NULL is a row no gap pass counted since).
  "0158_mailboxes_gap_strangers": [
    "61575c84e175babb",   // ADD COLUMN IF NOT EXISTS mailboxes.gap_strangers integer
  ],
  // THE READER'S PRESS ORDERING — one nullable timestamptz on rules, IF NOT EXISTS: no default, no
  // index, no DML (NULL is a row no reader press settled on unchanged since).
  "0159_rules_settled_press_at": [
    "3dddc21898e441c4",   // ADD COLUMN IF NOT EXISTS rules.settled_press_at timestamptz
  ],
  // THE MAILBOX POLL'S OUTSTANDING FILINGS — folder_state.outstanding_account_id (a nullable column
  // added where missing), the BEFORE trigger that copies the message's account onto an outstanding
  // row, its partial index (prebuilt CONCURRENTLY by setup) and the backfill of the rows outstanding
  // before it, read through that index.
  "0160_folder_state_outstanding": [
    "5db6d60f29c42909",   // DO … ADD COLUMN IF NOT EXISTS folder_state.outstanding_account_id uuid, where information_schema lacks it
    "d7642e1d15875451",   // CREATE OR REPLACE FUNCTION folder_state_outstanding_account() … NEW.outstanding_account_id := messages.account_id
    "5a0466bd3d616aee",   // DO … CREATE TRIGGER folder_state_outstanding_account_tg BEFORE INSERT OR UPDATE … WHEN (outstanding), where pg_trigger lacks it
    "085861cdbfafb977",   // create index if not exists folder_state_outstanding_idx (outstanding_account_id, message_id) where outstanding
    "8362d03f326e250e",   // UPDATE folder_state SET outstanding_account_id = messages.account_id WHERE IS NULL and outstanding
  ],
  // THE MAILBOX LIST READ'S INDEX — mailboxes (account_id, id), prebuilt CONCURRENTLY by setup. No DML.
  "0161_mailboxes_account_idx": [
    "ff852b369d4313f6",   // create index if not exists mailboxes_account_idx (account_id, id)
  ],
  // THE SEND'S OFFER STATE — one text column on outbound_sends with a constant default, IF NOT
  // EXISTS (metadata-only). No index, no DML.
  "0162_outbound_sends_offer_state": [
    "a834f367d628f76f",   // ADD COLUMN IF NOT EXISTS outbound_sends.offer_state text NOT NULL DEFAULT 'unknown'
  ],
  // A NEW FILING STARTS FRESH — the trigger function that resets the schedule and the refusal class,
  // and the BEFORE UPDATE trigger that runs it when desired_folder changes, where pg_trigger lacks it.
  // No DML.
  "0163_folder_state_fresh_intent": [
    "6634aeab0254ff67",   // CREATE OR REPLACE FUNCTION folder_state_fresh_intent() … attempts 0, next_attempt_at and last_error_class NULL
    "d3d90621a05fabdf",   // DO … CREATE TRIGGER folder_state_fresh_intent_tg BEFORE UPDATE … WHEN desired_folder changes, where pg_trigger lacks it
  ],
  // CLOUD 0041 — content identity for a staged attachment. One added column and the CHECK that
  // fixes its shape, drop-then-add, NOT VALID on a growth table. No DML: the column is NULLABLE,
  // so every ticket already staged keeps its only judgement (its size) and the NULL it carries.
  "0041_attachment_staging_digest": [
    "7020ba1679b7e00c",   // ADD COLUMN IF NOT EXISTS "content_sha256" text
    "902919f3383a076c",   // DROP CONSTRAINT IF EXISTS attachment_staging_content_sha256_hex
    "64db9e5330aa2893",   // ADD CONSTRAINT … CHECK (NULL or 64 lowercase hex) NOT VALID
  ],
  // CLOUD 0042 — the desktop approval row on `login_tokens`. NOT NULL dropped on `user_id` (an
  // unconfirmed approval has no user), six additive columns with defaults, and the CHECK that
  // admits the NULL for `desktop_approval` alone, drop-then-add and NOT VALID on a growth table. No DML.
  "0042_desktop_approval": [
    "a7afc04a0bcdd272",   // ALTER COLUMN "user_id" DROP NOT NULL
    "063da7bdb29a2d6f",   // ADD COLUMN IF NOT EXISTS "label" text DEFAULT '' NOT NULL
    "229f3267878dc276",   // ADD COLUMN IF NOT EXISTS "platform" text DEFAULT '' NOT NULL
    "f2d09c6d94555e24",   // ADD COLUMN IF NOT EXISTS "ip_class" text DEFAULT '' NOT NULL
    "deaa90989b65394e",   // ADD COLUMN IF NOT EXISTS "approved_at" timestamptz
    "3af004790442c6a3",   // ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz
    "35a5470758c3eed8",   // ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL
    "3b8b996df0701539",   // DROP CONSTRAINT IF EXISTS login_tokens_unbound_is_approval
    "93abc3e17c53ae68",   // ADD CONSTRAINT … CHECK (user_id IS NOT NULL OR purpose = 'desktop_approval') NOT VALID
  ],
  // CLOUD 0043 — the tokens of an erased account, by hash. One new table, no DML, no index: the
  // erasure writes it and the session door reads it by its primary key.
  "0043_erased_bearers": [
    "c352d2ebca56a4cb",   // CREATE TABLE erased_bearers (token_hash PK, account_id → accounts, expires_at)
  ],
  // CLOUD 0044 — `upstream_refused` joins the sample-cause CHECK. TWO statements and ONE hash: the
  // DROP normalises to 0030's own drop of the same constraint (`2e7e15ae83e3d505`, exempt there),
  // so only the redefined CHECK is new, added NOT VALID. No DML: no stored cause changes.
  "0044_platform_signals_upstream_refused": [
    "479e849605dcd190",   // ADD CONSTRAINT platform_signals_sample_cause_check … 'upstream_refused' … NOT VALID
  ],
  // CLOUD 0045 — 0041's digest CHECK validated, one release after it was added NOT VALID. One
  // VALIDATE CONSTRAINT and nothing else (SHARE UPDATE EXCLUSIVE: reads and writes continue).
  "0045_attachment_staging_digest_validate": [
    "0967136d9f46db45",   // VALIDATE CONSTRAINT attachment_staging_content_sha256_hex
  ],
  // CLOUD 0046 — an authenticator replacement in progress: three nullable columns on
  // `totp_secrets` and ONE CHECK sealing all three, in 0036's drop-then-add shape. No DML.
  "0046_totp_pending_replacement": [
    "6e6453767bbd8854",   // ALTER TABLE totp_secrets ADD COLUMN IF NOT EXISTS pending_secret_enc text
    "835732344ec71b79",   // ALTER TABLE totp_secrets ADD COLUMN IF NOT EXISTS pending_key_version integer
    "db64f75f77012c53",   // ALTER TABLE totp_secrets ADD COLUMN IF NOT EXISTS pending_started_at timestamptz
    "361ad7c007d331cc",   // ALTER TABLE totp_secrets DROP CONSTRAINT IF EXISTS totp_secrets_pending_sealed_together
    "40e4987ebb0fefae",   // ADD CONSTRAINT … CHECK ((enc IS NULL) = (version IS NULL) AND (enc IS NULL) = (started IS NULL))
  ],
  // CLOUD 0047 — staff roles and the append-only staff audit: two tables, their indexes, the staff-owner
  // backfill (one grant per existing staff row), the trigger that refuses UPDATE, DELETE and
  // TRUNCATE, and TRUNCATE revoked.
  "0047_staff_roles_and_audit": [
    "5d1e7e76c8cfe5e4",   // CREATE TABLE staff_role_grants
    "684f474e492c08d2",   // CREATE UNIQUE INDEX staff_role_grants_live_uq … WHERE revoked_at IS NULL
    "5c4594d3a4ec8b38",   // INSERT INTO staff_role_grants … SELECT id, 'owner' FROM staff_users
    "44f0e144405612a2",   // CREATE TABLE staff_audit_events
    "eeb16f0f6a51dd86",   // CREATE INDEX staff_audit_events_account_at_idx
    "aadf74174f0e1127",   // CREATE INDEX staff_audit_events_staff_at_idx
    "514db3e114d2e012",   // CREATE INDEX staff_audit_events_request_idx
    "b54880b4518b1c83",   // CREATE OR REPLACE FUNCTION staff_audit_events_append_only
    "ed9763788e378559",   // DROP TRIGGER IF EXISTS staff_audit_events_no_change
    "b03c6a271bb34da7",   // CREATE TRIGGER staff_audit_events_no_change BEFORE UPDATE OR DELETE
    "6371c8bd5c888d30",   // DROP TRIGGER IF EXISTS staff_audit_events_no_truncate
    "6f9b3acdca5fb1b0",   // CREATE TRIGGER staff_audit_events_no_truncate BEFORE TRUNCATE
    "64ffe2eff2a426bd",   // REVOKE TRUNCATE … FROM PUBLIC
    "c2f79421850d44c4",   // REVOKE TRUNCATE … FROM CURRENT_USER
  ],
  // CLOUD 0048 — the alert drivers' per-day gap history: one new table, no DML, no index.
  "0048_alert_driver_gaps": [
    "5472957cec16b6d0",   // CREATE TABLE alert_driver_gaps (driver, day PK; passes, max_gap_s, max_gap_at)
  ],
  // CLOUD 0049 — the staff role's grant on 0048's table, for a database migrated but not re-hardened:
  // one DO block, guarded on `ohmail_admin` existing, no DDL on any object and no DML.
  "0049_alert_driver_gaps_staff_grant": [
    "73836bf7c0d8d72d",   // DO … REVOKE ALL, then GRANT SELECT/INSERT/UPDATE (five columns) TO ohmail_admin
  ],
  // CLOUD 0050 — the staff billing link joins the notice ledger: the kind CHECK redefined with a
  // fifth word in 0044's drop-then-add NOT VALID shape. The DROP is new (0040 only created the
  // constraint), so both statements are named. No DML.
  "0050_billing_link_notices": [
    "fadf3cda18b3d0cd",   // ALTER TABLE account_lifecycle_notices DROP CONSTRAINT IF EXISTS …_kind_closed
    "90bd859867744d8f",   // ADD CONSTRAINT account_lifecycle_notices_kind_closed … 'billing_link' … NOT VALID
  ],
  // CLOUD 0051 — alert drills: one new table, its partial ack index, and the staff role's grant on it
  // in a DO block guarded on `ohmail_admin` existing. No DML.
  "0051_alert_drills": [
    "43f81f1cca91246f",   // CREATE TABLE alert_drills (run, kind, driver, sink PK; nine CHECKs)
    "d7b14e32c7b508fd",   // CREATE INDEX alert_drills_ack_idx ON alert_drills (ack_token_hash) WHERE … IS NOT NULL
    "d4a74f3bdce89ea2",   // DO … REVOKE ALL, then GRANT SELECT (ten) / INSERT (nine) / UPDATE (two) TO ohmail_admin
  ],
};

/** Short, stable identity for one normalized statement. */
const hashOf = (normalized: string): string =>
  createHash("sha256").update(normalized).digest("hex").slice(0, 16);

/** Every exempted hash, flattened — the set the permutation oracle subtracts. */
const POST_SPLIT_HASHES: ReadonlySet<string> = new Set(
  Object.values(POST_SPLIT_STATEMENTS).flat(),
);

/** The tags that carry post-split work, derived so the two cannot disagree. */
const POST_SPLIT_TAGS: ReadonlySet<string> = new Set(Object.keys(POST_SPLIT_STATEMENTS));

/**
 * `DROP INDEX` names an index, not a table. Two occurrences: the second is 0021's own drop, added
 * when that entry took the replayable drop-then-create form — it names the index the very next
 * statement builds, so its owning table is the one that statement already declares.
 */
const DROPPED_INDEX_OWNER: Record<string, string> = {
  users_email_idx: "users",
  mailboxes_active_address_uq: "mailboxes",
};

const stripComments = (s: string): string => s.replace(/^\s*--[^\n]*$/gm, "");

function collect(src: string, patterns: RegExp[]): string[] {
  const hits = new Set<string>();
  for (const p of patterns) {
    const re = new RegExp(p.source, p.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) hits.add(m[1]!);
  }
  return [...hits];
}

/**
 * Tables whose SCHEMA a statement changes — `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX … ON`,
 * `DROP INDEX`. This is the set the closure rule polices, and it deliberately excludes `UPDATE`:
 * a data backfill is not a schema definition, and treating it as one would make the one
 * legitimate cross-half statement in the whole history look like a violation.
 */
export function ddlTables(chunk: string): string[] {
  const s = stripComments(chunk);
  const hits = new Set(collect(s, [
    /CREATE TABLE (?:IF NOT EXISTS )?"([a-z_]+)"/gi,
    /ALTER TABLE "([a-z_]+)"/gi,
    /CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"[a-z_]+" ON "([a-z_]+)"/gi,
  ]));
  const dropRe = /DROP INDEX IF EXISTS "([a-z_]+)"/gi;
  let d: RegExpExecArray | null;
  while ((d = dropRe.exec(s))) {
    const owner = DROPPED_INDEX_OWNER[d[1]!];
    if (!owner) throw new Error(`DROP INDEX "${d[1]}" — add its owning table to DROPPED_INDEX_OWNER`);
    hits.add(owner);
  }
  return [...hits];
}

/** Tables a statement WRITES — DDL plus `UPDATE`. What decides which journal owns it. */
export function writtenTables(chunk: string): string[] {
  return [...new Set([...ddlTables(chunk), ...collect(stripComments(chunk), [/UPDATE "([a-z_]+)"/gi])])];
}

/** EVERY table a statement names — the above plus FK targets and subquery reads. */
export function namedTables(chunk: string): string[] {
  const s = stripComments(chunk);
  return [...new Set([
    ...writtenTables(chunk),
    ...collect(s, [/REFERENCES "public"\."([a-z_]+)"/gi, /FROM "([a-z_]+)"/gi]),
  ])];
}

describe("the two journals are well-formed", () => {
  // The literal counts include post-split migrations (see POST_SPLIT_TAGS): 0000–0047 on the
  // mail side, 0000–0008 on the cloud side. They stay literals on purpose — a journal that
  // silently LOST an entry must not pass by being internally consistent about a shorter list —
  // so adding a migration means bumping the number here, deliberately, in the same diff.
  //
  // 45 → 48 for `0045_draft_bcc`, `0046_screener_auto_apply` and `0047_read_order`, and this was
  // paid THREE migrations late. All three landed with their `/health` markers and the
  // `MAIL_SCHEMA_MARKER_JOURNAL_TAG` bump but with none of the census bumps, so this file, the
  // `POST_SPLIT_STATEMENTS` list above, `baseline-adoption.test.ts`'s frozen list and
  // `search-extensions.pg.test.ts`'s `MAIL_ENTRIES` were all red together. Recorded rather than
  // quietly bumped, because the census's whole purpose is that somebody reads the statements
  // before blessing them — three at once is three authorship reviews, not one.
  //
  // 48 → 49 for `0048_remote_images_default`, paid in the same diff as the migration — which is
  // what the paragraph above asks for, and is only worth noting because the previous three were
  // not. The gate did its job: all three counts here went red the first time the whole suite ran
  // after the file landed, before it reached a deploy.
  // 9 → 10 on the cloud side for `0009_mailbox_oauth`, paid in the same diff as the migration —
  // which is what the paragraph above asks for.
  //
  // 49 → 51 for `0049_mailbox_sync_requested_at` AND `0050_rule_subject_contains`, and the two are
  // in one diff for opposite reasons. `0050` is paying in its own diff, as asked. `0049` was ALREADY
  // ON `main` WITH NO CENSUS BUMP AT ALL — this file, `baseline-adoption.test.ts` and
  // `search-extensions.pg.test.ts` were red on the default branch, which is the same debt the
  // `0045`–`0047` note above records and the second time it has happened. Blessing somebody else's
  // migration is not what this census is for, so `0049`'s statement was read against its file's own
  // prose before its hash went into the list above; see the entry there.
  //
  // 51 → 52 for `0051_away_responder`, paid in the same diff as the migration.
  //
  // ITS `when` IS NOT THE ONE IT WAS AUTHORED WITH, and the reason belongs here rather than in a
  // report. `0051` was written while `0050` was in another unpushed tree, so it took
  // 1788641686206 — the next value after `0049`. `0050` then landed with 1788728086206, ABOVE it.
  // The migrator applies an entry iff the greatest `created_at` in its table is BELOW that entry's
  // `when`, so leaving `0051` where it was would have made it unapplied and unappliable FOR EVER on
  // any database that took `0050` first, silently, which is the exact defect the strictly-increasing
  // check below exists to catch. It was rebased to 1788814486206 instead. Nothing else in the
  // migration changed, so its statement hashes above are unaffected — only the ORDER it runs in.
  //
  // 52 → 53 for `0052_rule_body_contains`, paid in its own diff — the third term on a sender rule,
  // 0050's shape statement for statement; see the entry above. Authored as a `0051` concurrently
  // with the away responder and renumbered when that one landed first; its `when` (1788908540527)
  // was picked strictly above the shared test database's maximum — which was ALREADY the away
  // responder's 1788814486206, one day past this journal's then-newest entry — and off the
  // max-plus-one-day lattice both sides derive, so the renumber moved no timestamp.
  //
  // 53 → 54 for `0053_account_locale`, paid in the same diff as the migration. Its `when`
  // (1788994940527) is the max-plus-one-day lattice value above `0052`'s, which was already the
  // journal's maximum — so it is strictly above every entry in this journal AND above the shared
  // test database's maximum, and the ordering check below is what would catch it if it were not.
  //
  // MAIL 54 → 55 for `0054_auto_unsubscribe_optout`, paid in the same diff as the migration: the
  // account switch for auto-unsubscribe on screen-out, stored as the opt-out; see the entry above.
  // Its `when` (1789081340527) is the next max-plus-one-day lattice value above `0053`'s, which
  // was the mail journal's maximum, so it is strictly above every entry here.
  //
  // CLOUD 10 → 11 for `0010_desktop_link_pkce` (the PKCE commitment column on `login_tokens`),
  // paid in the same diff as the migration, along with `POST_SPLIT_STATEMENTS` below,
  // `baseline-adoption.test.ts`'s frozen cloud list, `search-extensions.pg.test.ts`'s
  // `CLOUD_ENTRIES` and the `CLOUD_SCHEMA_MARKER_JOURNAL_TAG` bump in `health-cloud.ts`.
  //
  // Its `when` (1789167740527) is NOT the lattice value above `0009`'s, and the reason is worth
  // recording because it is the ordering trap actually firing rather than being reasoned about.
  // The max-plus-one-day value above `0009` (1787820886206) is strictly above every entry in this
  // journal and was still WRONG: the shared Postgres test database's `drizzle_cloud`
  // `__drizzle_migrations` already held a row at 1789081340527, and the migrator applies an entry
  // only when the table's MAXIMUM `created_at` is below it. So the migration was skipped, silently
  // and permanently, and the pg suite failed with a 500 from an undefined column rather than with
  // anything naming a migration. `when` has to clear the highest value the target database has
  // ever seen, not merely this journal's own maximum — the same rule the mail side's `0053` note
  // states, met here the expensive way.
  //
  // CLOUD 11 → 12 for `0011_trial_credits` (the ledger's `trial_grant` reason and its `trial:`
  // source namespace), paid in the same diff as the migration along with the other censuses.
  //
  // AND IT IS THE OTHER HALF OF THE STORY ABOVE. This migration was authored as `0010` with
  // `when` 1789081340527 — which is the exact value the note above found sitting in the shared
  // test database's `drizzle_cloud` table and could not explain. That row was this migration,
  // written there by its own pg runs while both slices were in flight. So the two collided twice:
  // on the TAG (two `0010_*` files) and on the ORDER (this one's `when` below the other's, which
  // would have made it unappliable for ever on any database that took the PKCE column first).
  //
  // Renumbered to `0011` and rebased to 1789254140527 — the lattice value above
  // `0010_desktop_link_pkce`, and therefore above every value either journal or the shared
  // database has ever held. The SQL did not change; only its number and its place in the order.
  // The rule both notes now state the same way: `when` must clear the highest value the TARGET
  // DATABASE has ever seen, not merely this journal's own maximum.
  //
  // MAIL 54 → 55 for `0054_auto_unsubscribe_optout` (the account switch for auto-unsubscribe on
  // screen-out, stored as the opt-out; see its `POST_SPLIT_STATEMENTS` entry above), paid in the
  // same diff as the migration. Its `when` (1789081340527) is the max-plus-one-day lattice value
  // above `0053`'s, which was the MAIL journal's maximum.
  //
  // IT IS THE SAME NUMBER THE CLOUD NOTE ABOVE SPENT A PARAGRAPH ON, AND THAT IS A COINCIDENCE
  // RATHER THAN THE SAME ROW — worth stating, because it is exactly the kind of collision a
  // reader would otherwise reconstruct wrongly. The two journals keep SEPARATE
  // `__drizzle_migrations` tables (`drizzle_mail` and `drizzle_cloud`), so neither can ever skip
  // the other; the value in `drizzle_cloud` was the trial-credits migration's own, as that note
  // says. Both landed on 1789081340527 because both derived it from the same lattice on the same
  // day, from different journals. Measured on the shared database after both applied:
  // `drizzle_mail` max 1789081340527, `drizzle_cloud` max 1789254140527.
  //
  // MAIL 55 → 56 for `0055_mailbox_smtp_max_size` (the SMTP `SIZE` announcement, per mailbox), paid
  // in the same diff as the migration along with the other three censuses and the `/health` marker.
  //
  // Its `when` (1789340540527) is NOT the lattice value above the MAIL journal's own maximum, and
  // the reason is the rule the two notes above learned the expensive way rather than a preference:
  // `when` must clear the highest value the TARGET DATABASE has ever seen. The mail journal's
  // maximum is `0054`'s 1789081340527, but the shared Postgres test database's `drizzle_cloud`
  // table already holds 1789254140527 (`0011_trial_credits`). The two journals keep separate
  // `__drizzle_migrations` tables, so the mail lattice value would in fact have applied — this
  // takes the value above BOTH anyway, measured on the shared database before it was chosen
  // (`drizzle_mail` max 1789081340527, `drizzle_cloud` max 1789254140527), because the cost of
  // clearing a number that did not need clearing is nothing and the cost of the reverse is a
  // migration skipped for ever, silently.
  //
  // MAIL 56 → 57 for `0056_screening_baseline` (the instant the dormancy window is measured back
  // from, per account), paid in the same diff as the migration along with the other three censuses
  // and the `/health` marker.
  //
  // Its `when` (1789426940527) clears BOTH journals' maxima, on the rule the four notes above
  // arrived at from three separate incidents: the mail journal's maximum is `0055`'s
  // 1789340540527 and the cloud journal's is `0011_trial_credits`'s 1789254140527, both re-read
  // before this value was chosen rather than carried over from the note above — a maximum that
  // was true last week is exactly the kind of fact this lattice keeps invalidating. The two
  // journals keep separate `__drizzle_migrations` tables, so the mail lattice value alone would
  // have applied; taking the value above both costs nothing and the alternative failure is
  // permanent and silent.
  //
  // MAIL 57 → 58 for `0057_message_from_name` (the From header's display name, per message),
  // paid in the same diff as the migration along with the other three censuses and the
  // `/health` marker.
  //
  // Its `when` (1789513340527) clears BOTH journals' maxima, re-read rather than carried over,
  // per the rule the notes above earned: the mail journal's maximum is `0056`'s 1789426940527
  // and the cloud journal's is `0011_trial_credits`'s 1789254140527. The separate
  // `__drizzle_migrations` tables mean the mail value alone would have applied; clearing both
  // costs nothing and the alternative failure is permanent and silent.
  //
  // MAIL 58 → 59 for `0058_reconcile_backoff` (`attempts` + `next_attempt_at` on `folder_state`
  // and `flag_state`, so a refused IMAP mutation can be deferred instead of retried every cycle),
  // paid in the same diff as the migration along with the other three censuses and the `/health`
  // marker. FOUR statement hashes and not one, because the columns land on two tables — the
  // largest `POST_SPLIT_STATEMENTS` entry since the identity work, and the entry's own note says
  // why a third or a fifth is a defect.
  //
  // ── THE RULE ABOVE EARNED ITS KEEP HERE, MEASURED ────────────────────────────────────────
  //
  // This migration was first authored with `when: 1789599740527` — mail's maximum plus a day,
  // which is what "the next one" looks like if you read only the journal you are adding to. That
  // value is ALREADY IN THE CLOUD JOURNAL, and the failure was not the `when` lattice at all: the
  // "two journals may share a `when`" test went from 4 shared values to 5, one file away from the
  // one being edited. Cloud had overtaken mail by four entries while nobody was looking, so its
  // maximum (`1789858940527`) is the one that mattered. Re-read BOTH, every time; a maximum that
  // was true when the note above was written is exactly the fact this lattice keeps invalidating.
  // The value taken (1789945340527) clears both.
  //
  // CLOUD 12 → 13 for `0012_billing_suspension` (`suspended_by` DROP NOT NULL — the billing
  // webhook's revenue-reversal suspend has no staff actor; see its `POST_SPLIT_STATEMENTS`
  // entry), paid in the same diff as the migration along with the other censuses and the cloud
  // `/health` marker bump.
  //
  // Its `when` (1789599740527) clears BOTH journals' maxima, re-read rather than carried over,
  // per the standing rule: the mail journal's maximum is `0057`'s 1789513340527 and the cloud
  // journal's is `0011_trial_credits`'s 1789254140527. The FIRST value picked here was the
  // lattice slot above the cloud maximum alone (1789340540527) — which is byte-identical to the
  // MAIL journal's `0055` `when`, and the shared-`when` census below (exactly four legacy
  // values) went red on it immediately. That is the census doing its job: a shared `when` is
  // harmless to the migrator (separate tables) but every accidental collision so far has been a
  // symptom of a value derived from a stale reading, and this one was.
  //
  // CLOUD 13 → 14 for `0013_ledger_integrity` (the account-keyed trial-once partial unique
  // index, the born-voided INSERT guard, and the refund cap folded into the refund-origin
  // trigger; see its `POST_SPLIT_STATEMENTS` entry), paid in the same diff as the migration
  // along with the cloud `/health` marker bump (`CLOUD_INDEX_MARKERS`, a new marker class —
  // the index is the only catalog-visible artifact; the two function replacements ride on it).
  //
  // Its `when` (1789686140527) clears BOTH journals' maxima, re-read rather than carried over,
  // per the standing rule: the mail journal's maximum is `0057`'s 1789513340527 and the cloud
  // journal's own is `0012`'s 1789599740527 — NOTE the cloud maximum is the larger one and sits
  // ~36 days in the future of the wall clock that wrote this, so a fresh `Date.now()` would
  // have been SILENTLY BELOW it, the exact skipped-forever trap the 0011 renumbering recorded.
  //
  // CLOUD 14 → 15 for `0014_ledger_trial_source` (the trial bounty's source must name its own
  // account — the half of R6-1-16 that 0013's count-keyed index left open; see its
  // `POST_SPLIT_STATEMENTS` entry), paid in the same diff as the migration along with the cloud
  // `/health` marker bump (`CLOUD_FUNCTION_MARKERS`, a new marker class again — a replaced
  // function BODY is this file's ENTIRE content, so unlike 0013 there is no index to ride).
  //
  // Its `when` (1789772540527) clears BOTH journals' maxima, re-read rather than carried over:
  // the mail journal's maximum is `0057`'s 1789513340527 and the cloud journal's own is `0013`'s
  // 1789686140527 — the larger, and still ~35 days ahead of the wall clock, so `Date.now()`
  // would again have been silently below it. It is the max-plus-one-day lattice value above
  // that maximum, and it appears in neither journal, so the shared-`when` census below stays at
  // exactly its four legacy values.
  //
  // CLOUD 15 → 16 for `0015_attachment_staging` (the row half of the hosted send's direct-upload
  // transport — see its `POST_SPLIT_STATEMENTS` entry and its `CLOUD_TABLES` note), paid in the
  // same diff as the migration along with the cloud `/health` marker: this one DOES create a
  // probeable column, so unlike 0013 and 0014 it needs no new marker CLASS, only an entry in
  // `CLOUD_SCHEMA_MARKERS` and the tag bump beside it.
  //
  // Its `when` (1789858940527) clears BOTH journals' maxima, re-read rather than carried over:
  // the mail journal's maximum is `0057`'s 1789513340527 and the cloud journal's own is `0014`'s
  // 1789772540527 — the larger, and still ahead of the wall clock that wrote this, so a fresh
  // `Date.now()` would again have been SILENTLY BELOW it. It is the max-plus-one-day lattice value
  // above that maximum, and it appears in neither journal, so the shared-`when` census below stays
  // at exactly its four legacy values.
  //
  // CLOUD 16 → 17 for `0016_ai_attempt_claims` (SEC3-MONEY-1's exclusive work claim — see its
  // `POST_SPLIT_STATEMENTS` entry and its `CLOUD_TABLES` note).
  //
  // Its `when` (1790031740527) clears BOTH journals' maxima, re-read rather than carried over —
  // and re-reading is the entire lesson this time, because carrying the number over is exactly the
  // mistake that was made. The FIRST value written here was 1789858940527 + one day, computed from
  // the cloud journal's own maximum and from the mail maximum this comment block already
  // recorded (`0057`'s 1789513340527). Both inputs were stale: mail had since taken
  // `0058_reconcile_backoff`, whose `when` is precisely that sum. The two journals collided, the
  // shared-`when` census went from four to five, and the census is the only thing that noticed.
  //
  // So: the maxima are 1789945340527 (mail `0058`) and 1789858940527 (cloud `0015`); this is the
  // max-plus-one-day lattice value above the LARGER, re-read from both files at the moment it was
  // chosen. It appears in neither journal, so the census below stays at exactly its four legacy
  // values. **The prose above a number is not a source for that number.**
  //
  // CLOUD 17 → 18 for `0017_oauth_code_twofa_provenance` (SEC3-AUTH-6's factor-time provenance —
  // see its `POST_SPLIT_STATEMENTS` entry above), paid in the same diff as the migration along
  // with the cloud `/health` marker: it adds a probeable column, so it needs no new marker CLASS,
  // only an entry in `CLOUD_SCHEMA_MARKERS` and the tag bump beside it.
  //
  // Its `when` (1790118140527) was chosen by RE-READING both journal files at the moment it was
  // written, which is the lesson the paragraph above exists to teach and which was followed here
  // rather than restated: the maxima are 1789945340527 (mail `0058_reconcile_backoff`) and
  // 1790031740527 (cloud `0016_ai_attempt_claims`), and this is the max-plus-one-day lattice value
  // above the LARGER of the two. It appears in neither journal, so the shared-`when` census below
  // stays at exactly its four legacy values. Note that the numbers quoted in the 0016 block above
  // were ALREADY STALE by the time this was written — mail had since taken `0058` — which is the
  // second demonstration in this file that the prose is not the source.
  // MAIL 59 → 60 for `0059_pairing_tokens` (the pairing-token lifecycle — the standalone
  // server's first-account setup token, family invites, QR device pairing; see its own header
  // and its `MAIL_TABLES` note), paid in the same diff as the migration along with the mail
  // `/health` marker (`["pairing_tokens","token_hash"]`) and the tag bump beside it.
  //
  // Its `when` (1790204540527) was chosen by RE-READING both journal files at the moment it was
  // written — the standing rule, and the wall clock proves it again: `Date.now()` at writing
  // was 1786951610505, BELOW even the mail maximum, so a fresh timestamp would have been
  // silently skipped forever. The maxima re-read were 1789945340527 (mail `0058_reconcile_backoff`)
  // and 1790118140527 (cloud `0017_oauth_code_twofa_provenance`); this is the max-plus-one-day
  // lattice value above the LARGER of the two. It appears in neither journal, so the
  // shared-`when` census below stays at exactly its four legacy values.
  //
  // CLOUD 18 → 19 for `0018_invites_confers_verified` (does redeeming this invite prove address
  // control? — see its `POST_SPLIT_STATEMENTS` entry above), paid in the same diff as the
  // migration along with the cloud `/health` marker (`["invites","confers_verified"]`) and the
  // tag bump beside it: one probeable column, so the ordinary marker class sees it.
  //
  // Its `when` (1790290940527) was chosen by RE-READING both journal files at the moment it was
  // written: `Date.now()` was 1786958448768 — below BOTH maxima, the skipped-forever trap live
  // again — and the maxima re-read were 1790204540527 (mail `0059_pairing_tokens`) and
  // 1790118140527 (cloud `0017_oauth_code_twofa_provenance`). This is the max-plus-one-day
  // lattice value above the LARGER of the two. It appears in neither journal, so the
  // shared-`when` census below stays at exactly its four legacy values.
  // MAIL 60 → 61 for `0060_refresh_tokens` (the rotating-refresh store moves to the shared half
  // for the desktop-as-host tier's paired devices — see its `MAIL_TABLES` note and its
  // `POST_SPLIT_STATEMENTS` entry), paid in the same diff as the migration along with the other
  // censuses and the mail `/health` marker.
  //
  // Its `when` (1790377340527) was chosen by RE-READING both journal files at the moment it was
  // written — the standing rule: the maxima re-read were 1790204540527 (mail
  // `0059_pairing_tokens`) and 1790290940527 (cloud `0018_invites_confers_verified`); this is
  // the max-plus-one-day lattice value above the LARGER of the two. It appears in neither
  // journal, so the shared-`when` census below stays at exactly its four legacy values.
  // MAIL 61 → 62 for `0061_web_sessions_deviceless` (plain browser sign-ins stop owning device
  // rows; the argued data backfill — see its `POST_SPLIT_STATEMENTS` entry), paid in the same
  // diff as the migration along with the mail marker-tag bump in `health.ts` (data-only, so the
  // marker CENSUS is unchanged — the tag moves, the probes do not; the reasoning sits on the
  // constant).
  //
  // Its `when` (1790463740527) was chosen by RE-READING both journal files at the moment it was
  // written — the standing rule, proven necessary again: `Date.now()` at writing was
  // 1787646000000-ish, below BOTH maxima, so a fresh timestamp would have been silently skipped
  // forever. The maxima re-read were 1790377340527 (mail `0060_refresh_tokens`) and
  // 1790290940527 (cloud `0018_invites_confers_verified`); this is the max-plus-one-day lattice
  // value above the LARGER of the two. It appears in neither journal, so the shared-`when`
  // census below stays at exactly its four legacy values.
  // MAIL 62 → 63 for `0062_storage_accounting` and CLOUD 19 → 20 for
  // `0019_storage_bytes_limit` — the managed storage cap's two halves, paid in the same diff as
  // the migrations along with the marker-tag bumps in `health.ts`/`health-cloud.ts`, the
  // `MAIL_TABLES` entry, both `POST_SPLIT_STATEMENTS` entries and the staff-grant censuses.
  //
  // Their `when`s were chosen by RE-READING both journal files at the moment they were written
  // — the standing rule. The maxima re-read were 1790463740527 (mail
  // `0061_web_sessions_deviceless`) and 1790290940527 (cloud `0018_invites_confers_verified`);
  // mail 0062 takes the max-plus-one-day lattice value above the larger (1790550140527) and
  // cloud 0019 the day after that (1790636540527) — two values, not one shared, because the
  // shared-`when` census below is pinned to exactly its four legacy collisions and a same-diff
  // pair reusing one timestamp would have become a fifth.
  // 20 → 23 on the cloud side for `0020_replan_2026_08_21`, `0021_setup_grants` and
  // `0022_subscription_addons` — paid in the same diff as the migrations, with the marker-tag
  // bump in `health-cloud.ts`, the `CLOUD_TABLES` pair and the `POST_SPLIT_STATEMENTS` entries.
  // MAIL 63 → 64 for `0063_smtp_size_probe_stamp` — the `SIZE` back-fill's durable attempt stamp,
  // paid in the same diff as the migration along with the mail marker-tag bump in `health.ts`, the
  // new column and CHECK markers there, and this file's `POST_SPLIT_STATEMENTS` entry. No
  // `MAIL_TABLES` change: it adds columns to an existing table and creates none.
  //
  // Its `when` (1790982140527) was chosen by RE-READING both journal files at the moment it was
  // written — the standing rule. The maxima re-read were 1790550140527 (mail
  // `0062_storage_accounting`) and 1790895740527 (cloud `0022_subscription_addons`), and this is the
  // max-plus-one-day lattice value above the LARGER of the two. Note which half that was: the cloud
  // journal is currently ahead, so a value merely above the mail maximum would still have been below
  // the shared test database's cloud rows — legal for the migrator (separate tables) but off the
  // lattice both sides derive, which is the invariant that keeps a same-day pair from colliding.
  // CLOUD 23 → 24 for `0023_billing_reconciliation` — the reconciliation run ledger, paid in the
  // same diff as the migration along with the marker-tag bump in `health-cloud.ts` (column +
  // index markers), the `CLOUD_TABLES` entry, `baseline-adoption.test.ts`'s frozen cloud list,
  // `search-extensions.pg.test.ts`'s `CLOUD_ENTRIES` and the `POST_SPLIT_STATEMENTS` entry above.
  //
  // Its `when` (1791068540527) was chosen by RE-READING both journal files at the moment it was
  // written — the standing rule. The maxima re-read were 1790982140527 (mail
  // `0063_smtp_size_probe_stamp`) and 1790895740527 (cloud `0022_subscription_addons`); this is
  // the max-plus-one-day lattice value above the LARGER, which is currently the MAIL side. The
  // first value chosen (cloud max + one day) was EXACTLY the mail maximum — the shared-`when`
  // census below caught it as a fifth collision before it shipped, which is that census earning
  // its keep.
  // MAIL 64 -> 70 for 0064-0069 (the device-sync stamp, the junk+delete columns, the folders
  // flag, the withdrawn-then-retired secdef pair, and the folders REISSUE) — each carries its
  // POST_SPLIT_STATEMENTS entry above, and 0064/0065's landing without this bump is the same
  // recorded drift the marker-tag history in health.ts names: caught here, not silently healed.
  // 0069 re-runs 0066's one idempotent statement from a position strictly above the journal's
  // maximum: 0066 was first minted BETWEEN two entries another lane had already landed and
  // applied, which the single-watermark migrator skips forever on any database already at 0068
  // — and retiming 0066 itself (the first repair) mutated an applied entry, leaving such
  // databases' bookkeeping rows undescribed. REISSUED_ORIGINALS (src/baseline.ts) carries the
  // full account, including the bookkeeping row the skipped population is owed.
  // MAIL 70 -> 71 for `0070_session_sync_stamp` — sessions.last_synced_at, the per-SESSION
  // twin of 0064's device stamp, for the deviceless installs the first real staleness incident
  // proved invisible. Paid in the same diff: the POST_SPLIT_STATEMENTS entry above, the
  // `["sessions","last_synced_at"]` marker in health.ts, and the staff-grants widening the
  // `session_sync_stale` rule reads. Its `when` (1791241340527) was chosen by RE-READING both
  // journal files at the moment it was written — the standing rule. The maxima re-read were
  // 1791154940527 (mail `0069_folders_enabled_reissue`) and 1791068540527 (cloud
  // `0023_billing_reconciliation`); this is the max-plus-one-day lattice value above the
  // LARGER, which is the MAIL side.
  // CLOUD 24 → 25 for `0024_auth_events_reuse_index` — the partial index the reuse-revocation
  // alert and the admin security row scan by (same review round as mail 0070's slice). Its
  // `when` (1791327740527) was chosen by RE-READING both journal files: the maxima were
  // 1791241340527 (mail `0070_session_sync_stamp`, this diff's own sibling) and 1791068540527
  // (cloud `0023_billing_reconciliation`); this is the max-plus-one-day lattice value above
  // the LARGER, which is the MAIL side again.
  // CLOUD 25 → 26 for `0025_alert_renotify_signature` — the renotify policy's
  // `notified_signature` column (see its POST_SPLIT_STATEMENTS entry). Its `when`
  // (1791327800527) is the re-read cloud maximum (0024's 1791327740527, already above the mail
  // side) plus one minute — strictly greater than both journals' maxima, which is the whole of
  // what the apply rule needs.
  // CLOUD 26 → 27 for `0026_alert_claim_lease` — the notify claim's own lease column (see its
  // POST_SPLIT_STATEMENTS entry). Its `when` (1791327860527) is 0025's plus one minute, by the
  // same rule.
  // MAIL 71 → 72 for `0071_withheld_provenance_index` — the husk-provenance partial index the
  // worker's `junk_filed` convergence pass reads by (see its POST_SPLIT_STATEMENTS entry). Its
  // `when` (1791327920527) was chosen by RE-READING both journal files at the moment it was
  // written — the standing rule. The maxima re-read were 1791241340527 (mail
  // `0070_session_sync_stamp`) and 1791327860527 (cloud `0026_alert_claim_lease`); this is the
  // LARGER — the cloud side this time — plus one minute, strictly greater than both.
  // MAIL 72 → 73 for `0072_tracking_pixels_optout` — the opt-out of pixel BLOCKING on
  // `account_settings` (see its POST_SPLIT_STATEMENTS entry). Its `when` (1791327920528) was chosen
  // by RE-READING both journal files: the maxima were 1791327920527 (mail 0071) and 1791327860527
  // (cloud 0026); this is the larger plus one, strictly greater than both.
  // MAIL 73 → 74 for `0073_mailbox_folders_optout` — the per-mailbox "Use folders" exception
  // stamp on `mailboxes` (see its POST_SPLIT_STATEMENTS entry). Its `when` (1791327920529) was
  // chosen by RE-READING both journal files: the maxima were 1791327920528 (mail 0072) and
  // 1791327860527 (cloud 0026); this is the larger plus one, strictly greater than both.
  // MAIL 74 → 75 for `0074_folder_ops` — the user-commanded folder verbs' command table (see
  // its POST_SPLIT_STATEMENTS entry). Its `when` (1791327920530) was chosen by RE-READING both
  // journal files: the maxima were 1791327920529 (mail 0073) and 1791327860527 (cloud 0026);
  // this is the larger plus one, strictly greater than both.
  // MAIL 75 → 76 for `0075_mailbox_signature` — the per-mailbox signature text on `mailboxes`
  // (see its POST_SPLIT_STATEMENTS entry). Its `when` (1791327920531) was chosen by RE-READING
  // both journal files: the maxima were 1791327920530 (mail 0074) and 1791327860527 (cloud
  // 0026); this is the larger plus one, strictly greater than both.
  // MAIL 76 → 77 for `0076_junk_sweep_request` — the one-time Quarantine→\Junk sweep's command
  // stamp on `mailboxes` (see its POST_SPLIT_STATEMENTS entry). Its `when` (1791327920532) was
  // chosen by RE-READING both journal files: the maxima were 1791327920531 (mail 0075) and
  // 1791327860527 (cloud 0026); this is the larger plus one, strictly greater than both.
  // MAIL 77 → 78 for `0077_send_later` — the draft's appointment columns and the worker's due
  // scan index (see its POST_SPLIT_STATEMENTS entry). Its `when` (1791327920533) was chosen by
  // RE-READING both journal files: the maxima were 1791327920532 (mail 0076) and 1791327860527
  // (cloud 0026); this is the larger plus one, strictly greater than both.
  // MAIL 78 → 79 for `0078_inbound_quiet` — the forwarding-detection notice's evidence pair on
  // `mailboxes` (see its POST_SPLIT_STATEMENTS entry). Its `when` (1791327920534) was chosen by
  // RE-READING both journal files: the maxima were 1791327920533 (mail 0077) and 1791327860527
  // (cloud 0026); this is the larger plus one, strictly greater than both.
  // MAIL 79 → 80 for `0079_erasure_fence` — the erasure marker on `accounts` (see its
  // POST_SPLIT_STATEMENTS entry). Its `when` (1791400000000) was chosen by RE-READING both
  // journal files: the maxima were 1791327920534 (mail 0078) and 1791327860527 (cloud 0026);
  // this is strictly greater than both, rounded rather than plus-one so the next author can see
  // the gap was deliberate.
  // MAIL 80 → 81 for `0080_sessions_access_token_hash_idx` — the auth lookup's index (see its
  // POST_SPLIT_STATEMENTS entry). PAID LATE: it landed with this literal, the frozen list in
  // `baseline-adoption.test.ts` and `search-extensions.pg.test.ts`'s MAIL_ENTRIES all left at
  // 0079, so this suite was red at HEAD from that commit until mail 0081 paid both.
  // MAIL 81 → 82 for `0081_sensitive_rescreen_cursor` — the one-time re-screen's durable resume
  // point on `mailboxes` (see its POST_SPLIT_STATEMENTS entry). Its `when` (1791600000000) was
  // chosen by RE-READING both journal files: the maxima were 1791500000000 (mail 0080) and
  // 1791327860527 (cloud 0026); this is strictly greater than both, rounded rather than plus-one
  // so the next author can see the gap was deliberate.
  // MAIL 82 → 83 for `0082_theme_face` — the account-wide appearance face (see its
  // POST_SPLIT_STATEMENTS entry). Paid in the same diff as the migration. Its `when`
  // (1791600000001) was chosen by re-reading both journal files: the maxima were
  // 1791600000000 (mail 0081) and 1791327860527 (cloud 0026); plus-one rather than rounded,
  // because 0081 already took the round number for this window.
  // MAIL 83 → 84 for `0083_organizer_role` — the organizing role split off the connection, plus
  // the onboarding state and the first-pull denominator (see its `POST_SPLIT_STATEMENTS` entry).
  // Paid in the same diff as the migration. Its `when` (1791600000002) was chosen by re-reading
  // both journal files: the maxima were 1791600000001 (mail 0082) and 1791327860527 (cloud 0026);
  // plus-one, because this window's round number went to 0081 and its successor to 0082.
  // MAIL 84 → 85 for `0084_ai_answered` — the answer `accounts.ai_enabled` cannot carry (see its
  // `POST_SPLIT_STATEMENTS` entry). Paid in the same diff as the migration. Its `when`
  // (1791600000003) was chosen by re-reading both journal files: the maxima were 1791600000002
  // (mail 0083) and 1791327860527 (cloud 0026); plus-one, continuing this window's run.
  // MAIL 85 → 86 for `0085_heal_disabled_readers` — the rows the old worker wrote after 0083's
  // backfill had already run (see its `POST_SPLIT_STATEMENTS` entry). Paid in the same diff as the
  // migration. Its `when` (1791600000004) was chosen by re-reading both journal files: the maxima
  // were 1791600000003 (mail 0084) and 1791327860527 (cloud 0026); plus-one, same run.
  // MAIL 86 → 87 for `0086_heal_reader_address_wide` — 0085's heal with the sibling test widened
  // from the account to the address (see its `POST_SPLIT_STATEMENTS` entry). Paid in the same diff
  // as the migration. Its `when` (1791600000005) was chosen by re-reading both journal files: the
  // maxima were 1791600000004 (mail 0085) and 1791327860527 (cloud 0026); plus-one, same run.
  // MAIL 87 → 88 for `0087_away_reply_throttle`, and MAIL 88 → 89 for `0088_symmetric_takeover` —
  // the notice's two instants, the release request and the reader's request queue (see its
  // `POST_SPLIT_STATEMENTS` entry, whose point is that the file carries NO data statement). Paid
  // in the same diff as the migration. Its `when` (1791600000007) was chosen by re-reading both
  // journal files: the maxima were 1791600000006 (mail 0087) and 1791327860527 (cloud 0026);
  // plus-one, continuing this window's run.
  // MAIL 89 → 90 for `0089_organizer_capability` — the fifth holder column, `organized_by_capabilities`
  // (see its `POST_SPLIT_STATEMENTS` entry). Paid in the same diff as the migration. Its `when`
  // (1791600000008) was chosen by re-reading both journal files: the maxima were 1791600000007
  // (mail 0088) and 1791327860527 (cloud 0026); plus-one, continuing this window's run.
  // CLOUD 28 → 29 for `0028_credit_rollup_and_account_setup_grant` — the console's credit read
  // path plus the account-keyed setup pool. Paid in the same diff as the migration. Its `when`
  // (1791327982108) was chosen by re-reading both journal files: the maxima were 1791600000005
  // (mail 0087) and 1791327921054 (cloud 0027); strictly after the cloud maximum, its own run.
  // CLOUD 29 → 30 for `0029_billing_invoices_platform_costs_ai_usage` — the invoice mirror plus
  // the two cost tables. Paid in the same diff as the migration. Its `when` (1791328043162) was
  // chosen by re-reading both journal files: the maxima were 1791600000007 (mail 0088) and
  // 1791327982108 (cloud 0028); strictly after the cloud maximum, its own run.
  // MAIL 90 → 91 for `0090_request_key` — the per-account HMAC key that makes a reader's decision
  // provable, plus the `refused` state an ack carries back (see its `POST_SPLIT_STATEMENTS`
  // entry). Paid in the same diff as the migration. Its `when` (1791600000009) was chosen by
  // re-reading both journal files: the maxima were 1791600000008 (mail 0089) and 1791328043162
  // (cloud 0030); plus-one, continuing this window's run.
  // MAIL 91 → 92 for `0091_request_refusal_closed` — the closed set behind
  // `organizer_requests.refused_reason`, moved out of the parser and into the schema so the
  // operator console's isolation sweep can classify the column as refused rather than tainted (see
  // its `POST_SPLIT_STATEMENTS` entry). Paid in the same diff as the migration. Its `when`
  // (1791600000010) was chosen by re-reading both journal files: the maxima were 1791600000009
  // (mail 0090) and 1791328043162 (cloud 0029); plus-one, continuing this window's run.
  //
  // CLOUD 30 → 31 for `0030_heartbeat_signals_alert_runs` — the incident/signal split, the
  // alerting's own pulse and the platform's request counts. Paid in the same diff as the
  // migration. Its `when` (1791328104216) was chosen by re-reading both journal files: the
  // maxima were 1791600000008 (mail 0089) and 1791328043162 (cloud 0029); strictly after the
  // cloud maximum, its own run.
  //
  // The two moved in SEPARATE lanes and land here together, which is the case this literal pair
  // exists to catch: each side counts its own journal, so a rebase that dropped either number
  // would leave the other looking correct.
  //
  // MAIL 92 → 93 for `0092_organizer_install_id` — the sixth holder column, `organized_by_install_id`
  // (see its `POST_SPLIT_STATEMENTS` entry). NOT paid in the same diff as the migration: the
  // migration renumbered itself to 0092 to sit behind the one already on main, and this literal
  // and the statement census were both left at the older count, so the file was red on the base
  // this lane rebased onto. Its `when` (1791600000011) continues the run after 0091's
  // 1791600000010.
  //
  // MAIL 93 → 94 for `0093_outbound_send_fingerprints` — the account's claim on the content of a
  // send, the duplicate defence that does not depend on the client keeping its key (see its
  // `POST_SPLIT_STATEMENTS` entry). It arrived here as 0092 and was RENUMBERED at this rebase,
  // because `0092_organizer_install_id` above had taken that index while both lanes were open.
  //
  // Its `when` is 1791600000021, and the gap is deliberate rather than sloppy. Plus-one was tried
  // and it collided: the sibling lane had already taken 1791600000011 from the same maximum, and
  // drizzle applies an entry only when its `when` sorts STRICTLY after the recorded maximum — so
  // on the shared test database this migration was recorded as applied and its CREATE TABLE never
  // ran, with no error anywhere. That is property 2 of this file biting for real, and the symptom
  // was `relation "outbound_send_fingerprints" does not exist` from a route test whose `beforeAll`
  // had just migrated. While lanes pick numbers in parallel, plus-one is a collision waiting to
  // happen; the gap leaves room for the ones still open.
  //
  // CLOUD 31 → 32 for CLOUD-LEDGER's `0031_credit_rollup_sweep_backlog`, which lands in the same
  // wave and in the OTHER spec. Neither lane could count both: each read the journal it could see.
  // The two do not collide — different journal, different `when` — and this line is the only place
  // the pair has to be stated as one number.
  //
  // MAIL 94 → 95 for `0094_request_kinds_moves_profile` — the widened request-kind CHECK and the
  // reader's profile mirror (see its `POST_SPLIT_STATEMENTS` entry). Paid in the same diff as the
  // migration, along with the statement census, the `MAIL_TABLES` entry for
  // `mailbox_profile_mirror` and that table's seed in the content-isolation sweep: 0092's own note
  // directly above records what it costs when they are not — the file was red on the base the next
  // lane rebased onto, and the lane that found it was not the lane that owed it. It ARRIVED as
  // 0093 at `when` 1791600000012 and was RENUMBERED at this rebase: the release that landed
  // `0093_outbound_send_fingerprints` above took both the index AND a HIGHER `when`, and an
  // entry whose `when` does not sort strictly after the recorded maximum is recorded as applied
  // without ever running — property 2 of this file, and the same bite the note above records.
  // Its `when` is 1791600100011, a step above that maximum and below the numbers the lanes
  // still open behind this one have taken.
  //
  // MAIL 95 → 96 for `0095_outbound_send_resolution` — the resolution of a send that could not be
  // confirmed, plus the `draft_id` constraint change that lets its draft finally be discarded (see
  // its `POST_SPLIT_STATEMENTS` entry). Paid in the same diff as the migration. Its `when`
  // (1791600200011) is strictly after the mail maximum this rebase landed on (1791600100011, mail
  // `0094_request_kinds_moves_profile`), which is the whole requirement: drizzle applies an entry
  // only when its `when` sorts strictly after the recorded maximum, so an equal or lower number is
  // recorded as applied and never runs. The gap is large on purpose — the migrations still open in
  // this wave take their numbers from the same maximum, and plus-one is a collision waiting to
  // happen.
  //
  // ITS `idx` IS 95 AND ITS TAG SAYS 0095, which is a coincidence restored rather than a rule.
  // `idx` is asserted CONTIGUOUS from zero by this very case, so a new entry can only be the next
  // one; the FILE was numbered 0095 while two migrations were still ahead of it in the 0.16 order,
  // and both landed first, so the two numbers meet again. Every earlier entry has idx == its tag
  // number only because nothing had ever skipped — the note stays so the next entry whose numbers
  // differ is not "fixed" by renaming its file into an existing tag.
  //
  // MAIL 96 → 97 for `0096_away_piles` — the away responder's pile scope
  // (`away_responders.piles`) and the bounce record (`away_sender_state.undeliverable_at`) (see its
  // `POST_SPLIT_STATEMENTS` entry). NOT paid in the same diff as the migration: the lane moved this
  // literal from 93 to 94 against its own base and wrote no paragraph for the move, so the count
  // arrives here without the note that justifies it — which is why it is written at the landing,
  // where the number is re-derived rather than merged. Its `when` (1791600400011) is strictly after
  // the mail maximum this rebase landed on (1791600200011, mail `0095_outbound_send_resolution`),
  // which is the whole requirement: drizzle applies an entry only when its `when` sorts strictly
  // after the recorded maximum, so an equal or lower number is recorded as applied and never runs.
  // It is also strictly below 1791600600011, which the lane behind this one has taken for
  // `0097_folder_state_last_error_class` — the reason these numbers are spaced rather than
  // consecutive while several lanes are open.
  //
  // ITS `idx` IS 96 AND ITS TAG SAYS 0096, and like 0095's above that is a coincidence rather than
  // a rule: the file was numbered 0096 while two migrations were still ahead of it in the 0.16
  // order, both landed first, and the two numbers met again. `idx` is asserted CONTIGUOUS from zero
  // by this very case, so nothing enforces the match — the note stays so the next entry whose
  // numbers differ is not "fixed" by renaming its file into an existing tag.
  //
  // MAIL 97 → 98 for `0097_folder_state_last_error_class` — the class a filing was refused with, on
  // `folder_state` (see its `POST_SPLIT_STATEMENTS` entry). Paid in the same diff as the migration.
  // Its `when` (1791600600011) is strictly after the mail maximum this rebase landed on
  // (1791600400011, mail `0096_away_piles`), which is the whole requirement: drizzle applies an
  // entry only when its `when` sorts strictly after the recorded maximum, so an equal or lower
  // number is recorded as applied and never runs.
  //
  // ITS `idx` IS 97 AND ITS TAG SAYS 0097, and as with 0095's and 0096's notes above that is a
  // coincidence restored rather than a rule. The file was numbered 0097 while three migrations of
  // this wave were still ahead of it in the landing order; all three landed first, so the two
  // numbers meet again. `idx` is asserted CONTIGUOUS from zero by this very case, so nothing
  // enforces the match — the note stays so the next entry whose numbers differ is not "fixed" by
  // renaming its file into an existing tag.
  //
  // MAIL 98 → 99 for `0098_signature_html` — the signature's markup half (0.16). Its `when`
  // (1791600800011) is strictly after the mail maximum this rebase landed on (1791600600011,
  // mail `0097_folder_state_last_error_class`), which is the requirement: drizzle applies an
  // entry only when its `when` sorts strictly after the recorded maximum, so an equal or lower
  // number is recorded as applied and never runs. Its `idx` is 98 and its tag says 0098.
  //
  // MAIL 99 → 100 for `0099_folder_state_trashed_from` — where a delete moved a message out of
  // (0.16). Its `when` (1791601000011) is strictly after the mail maximum this landing rebased
  // onto (1791600800011, mail `0098_signature_html`); its `idx` is 99 and its tag says 0099.
  //
  // MAIL 100 → 101 for `0100_reader_window_peer_restamp` — the one-time re-stamp of mail another
  // install of the account filed (0.17). Its `when` (1791601200011) is strictly after 0099's
  // (1791601000011), the maximum this landing rebased onto; its `idx` is 100 and its tag says
  // 0100, so the two agree. The pre-rebase body of this pin explained a MISMATCH — the file was
  // numbered past 0099 while 0099 sat unlanded on another branch — and the mismatch is gone
  // because 0099 landed first; the file was never renamed, which is why the numbers met.
  //
  // TWO `+1`s FROM ONE BASE MERGE TO ONE, and this case is where that was paid for: 0099 and 0100
  // each moved this literal 99 → 100 against the same base, git took 100 with no conflict, and
  // 100 is wrong for a journal holding both. The number is RE-DERIVED from the journal in the
  // tree at every landing, never incremented from what the file said.
  //
  // MAIL 101 -> 102 for `0101_away_piles_wider`, which landed while this change was rebasing.
  // Both numbers are RE-DERIVED from the journals in the tree, never incremented from what the
  // file said.
  //
  // CLOUD 32 → 18. Fifteen metering migrations left this journal with the tables they created,
  // and `0032_retire_billing_tables` took their place, so the count falls by fourteen. Every
  // kept entry's `when` is unchanged; only `idx` was closed up, which is what this case reads.
  // MAIL 102 → 103 for `0102_sync_blocked_reason_read_limited` — the fourth
  // `sync_blocked_reason`, a CHECK widened rather than a column added. Its `when`
  // (1791601600011) is strictly above the landed maximum this batch rebased onto
  // (1791601400011, mail `0101_away_piles_wider`); the file was renamed from 0100, whose
  // number the landed journal had already taken. RE-DERIVED from the journal in the tree.
  //
  // MAIL 103 → 104 for `0103_organizer_kind_mobile` — `mobile` joins the two closed sets on
  // `mailboxes`, two CHECKs widened rather than a column added. Its `when` (1791601800011) is
  // strictly above the landed maximum this lane was cut from (1791601600011, mail
  // `0102_sync_blocked_reason_read_limited`). RE-DERIVED from the journal in the tree.
  //
  // MAIL 107 → 108 for `0107_release_held_at` — one nullable column on `rules`, the press that
  // releases mail held at the screening gate behind a rule its owner already wrote. Its `when`
  // (1791601800012) is strictly above the landed maximum this lane was cut from (1791601800011,
  // mail `0103_organizer_kind_mobile`). RE-DERIVED from the journal in the tree.
  // CLOUD 18 → 19 for `0033_api_faults` — one new table, renumbered from 0032 at this
  // landing because `0032_retire_billing_tables` had taken that number. Its `when`
  // (1791328224216) is strictly above the landed maximum (1791328164217). RE-DERIVED
  // from the journal in the tree.
  //
  // MAIL 106 → 107 for `0106_screening_baseline_backfill` and 107 → 108 for
  // `0107_release_held_at` — both RENUMBERED at the landing, because two mail migrations had
  // landed under 0104 meanwhile. One is a guarded backfill, the other one nullable column.
  //
  // CLOUD 19 → 20 for `0034_webauthn_challenge_expiry` — one index on the challenge table.
  //
  // CLOUD 20 → 21 for `0035_webauthn_open_ceremony_idx` — two indexes on that same table, for the
  // read 0034's index cannot serve. Its `when` (1791328224218) is strictly above the landed
  // maximum this lane was cut from (1791328224217, cloud `0034_webauthn_challenge_expiry`). Every
  // count is RE-DERIVED from each spec's own journal at this tip, never carried across a rebase.
  //
  // CLOUD 21 → 22 for `0036_refund_obligations` — one table, its unique key, three CHECKs and one
  // index: a spend that bought nothing leaves a durable obligation to refund it. Its `when`
  // (1791328224219) is strictly above the landed maximum this lane was cut from (1791328224218,
  // cloud `0035_webauthn_open_ceremony_idx`), and it is RE-DERIVED at the landing rather than
  // carried — this lane lands LAST in its batch for exactly that reason.
  //
  // MAIL 108 → 109 for `0108_mailbox_signed_out_at` — one nullable column on `mailboxes`, the
  // instant this install last signed out of that mailbox, which every credential writer re-reads
  // before it seals a password. Its `when` (1791602600012) is strictly above the landed maximum
  // this lane was cut from (1791602600011, mail `0107_release_held_at`). RE-DERIVED from the
  // journal in the tree.
  //
  // MAIL 109 → 110 for `0109_gate_release_done_at` — one nullable column on `account_settings`,
  // the per-account marker of the one-time gate release. Its `when` (1791602600013) is strictly
  // above the landed maximum this lane was cut from (1791602600012, mail
  // `0108_mailbox_signed_out_at`). RE-DERIVED from the journal in the tree.
  //
  // MAIL 110 → 111 for `0110_resurface_time` — one nullable text column on `account_settings`,
  // the wall clock a person's resurfaced mail comes back at. Its `when` (1791602600014) is
  // strictly above the landed maximum this lane was cut from (1791602600013, mail
  // `0109_gate_release_done_at`). RE-DERIVED from the journal in the tree.
  //
  // MAIL 111 → 112 for `0111_mailbox_erased_at` — one nullable timestamptz on `mailboxes`, the
  // MAILBOX erasure fence's stamp. Its `when` (1791602600015) is strictly above the landed
  // maximum this lane was cut from (1791602600014, mail `0110_resurface_time`). RE-DERIVED from
  // the journal in the tree.
  //
  // MAIL 112 → 113 for `0112_idempotency_erased_at` — one nullable timestamptz on
  // `idempotency_keys`, the instant an erasure replaced the response that row had stored. Its
  // `when` (1791602600016) is strictly above the landed maximum it was RENUMBERED onto
  // (1791602600015, mail `0111_mailbox_erased_at`). RE-DERIVED from the journal in the tree.
  //
  // MAIL 113 → 114 for `0113_refresh_consumed_by_attempt` — one nullable text column on
  // `refresh_tokens`, which attempt consumed it, so a retry of an unanswered refresh stops
  // reading as a replay. RENUMBERED from 0112 by the K33 landing: two unlanded lanes carried a
  // `0111` and a third a `0112`, and this one landed last of the three. Its `when`
  // (1791602600017) is strictly above the landed maximum it was RENUMBERED onto (1791602600016,
  // mail `0112_idempotency_erased_at`). RE-DERIVED from the journal in the tree.
  //
  // MAIL 114 → 115 for `0114_away_rotation_stamp` — one additive NOT NULL column with a
  // `to_timestamp(0)` default on `away_responders`, the instant the away pass last walked a
  // responder. The provisional tag 0114 SURVIVED the landing: three lanes carried mail
  // 0111/0111/0112 and this one landed last of the four, so 0114 is also its final number. Its
  // `when` (1791602600018) is strictly above the landed maximum it was rebased onto
  // (1791602600017, mail `0113_refresh_consumed_by_attempt`). RE-DERIVED from the journal.
  //
  // MAIL 115 → 116 for `0115_first_sync_budget_stop` — two additive nullable columns on
  // `mailbox_folders`, where a budgeted first sync's byte budget ran out, so a restart resumes
  // there instead of returning to INBOX. Its `when` (1791602600019) is strictly above the landed
  // maximum this lane was rebased onto (1791602600018, mail `0114_away_rotation_stamp`).
  // RE-DERIVED from the journal in the tree.
  //
  // CLOUD 20 → 21 for `0036_staff_step_up_and_pending_totp` — the pending authenticator pair, the
  // session's step-up stamp and the staff audit table. Its `when` (1791328224219) is strictly
  // above the landed maximum this lane was cut from (1791328224218, cloud
  // `0035_webauthn_open_ceremony_idx`). RE-DERIVED from the journal in the tree.
  //
  // CLOUD 21 → 22 for `0037_refund_obligations` — what this server owes somebody whose metered
  // press bought nothing. RENUMBERED from 0036 by the K33 landing, which landed the staff step-up
  // row first. Its `when` (1791328224220) is strictly above the landed maximum it was RENUMBERED
  // onto (1791328224219, cloud `0036_staff_step_up_and_pending_totp`). RE-DERIVED from the journal.
  //
  // MAIL 116 → 117 for `0116_unsub_drain_cursor` — two tables and one index: the drain's
  // per-message mark, where its window walk stopped, and the index over the window it walks. Its
  // `when` (1791602600020) is strictly above the landed maximum it was rebased onto
  // (1791602600019, mail `0115_first_sync_budget_stop`). RE-DERIVED from the journal in the tree.
  //
  // MAIL 117 → 118 for `0117_junk_rescues` — "not junk" becomes a command the organizer executes,
  // which closes the rule that the API never opens IMAP to APPLY organization. Its `when`
  // (1791602600021) is strictly above the landed maximum it was rebased onto (1791602600020). It
  // was 0115 and then 0116 on two earlier bases, and both collided with a lane that landed first:
  // that is exactly why the number and the `when` are RE-READ from the landed journal at every
  // rebase rather than adjusted by arithmetic.
  //
  // MAIL 118 → 119 and CLOUD 23 → 24 for `0118_account_isolation` / `0038_account_isolation` —
  // the composite account keys, one entry per journal. It lands in the SAME batch as
  // `0117_junk_rescues` and directly after it, so `idx` 118 and the tag agree and nothing skips.
  // Both `when`s are strictly above their journal's landed maximum. RE-DERIVED from the journals
  // in the tree.
  //
  // MAIL 119 → 120 for `0119_messages_arrived_at` — the honest arrival (INTERNALDATE), the truth
  // the Ohbox's sort clamp keys on (FIX-020). Its `when` (1791602600023) is strictly above the
  // landed maximum it was rebased onto (1791602600022, mail `0118_account_isolation`).
  // RE-DERIVED from the journal in the tree.
  // CLOUD 24 → 25 for `0039_screener_suggest_owed` — the suggest-owed mark the ingest writes and
  // the cycle's owed-first serve retires. Its `when` (1791328224222) is strictly above the landed
  // maximum this lane was rebased onto (1791328224221, cloud `0038_account_isolation`).
  // RE-DERIVED from the journal in the tree.
  // MAIL 120 → 121 for `0120_held_release_dismissed` — the dismissed held-release offer's
  // fingerprint on `account_settings` (FIX-021). Its `when` (1791602600024) is strictly above the
  // landed maximum it was rebased onto (1791602600023, mail `0119_messages_arrived_at`).
  // RE-DERIVED from the journal in the tree.
  // MAIL 121 → 122 for `0121_release_refusal` — the sibling-lapse discriminator on `mailboxes`
  // (a desktop robustness fix, renumbered off 0120 at its landing because 0.20.1's
  // `0120_held_release_dismissed` holds that number). Its `when` (1791602600025) is strictly
  // above the landed maximum it was rebased onto (1791602600024). RE-DERIVED from the journal.
  // MAIL 122 → 123 for `0122_change_log_retention` — the retention floor the sync route reads,
  // renumbered off 0120 at the same landing. Its `when` (1791602600026) is strictly above the
  // landed maximum it was rebased onto (1791602600025, mail `0121_release_refusal`). CLOUD stays
  // at 25: the auth_events prune's key is built CONCURRENTLY from its spec, so that lane adds no
  // cloud entry at all. RE-DERIVED from the journals in the tree.

  // MAIL 123 → 124 for `0123_news_pile_check` — the away-piles CHECK widened for the 0.22
  // News folder rename. Its `when` (1791602600027) is strictly
  // above the landed maximum it was rebased onto (1791602600026, mail `0122_change_log_retention`).
  // RE-DERIVED from the journal in the tree.

  // MAIL 123 → 124 for `0124_sync_blocked_reason_account_closed` — the wall's sixth
  // `sync_blocked_reason`, numbered 0124 because RENAME-022 takes 0123 at its tip (the landing
  // re-numbers if the order moves). Its `when` (1791602600027) is strictly above the landed
  // maximum it was rebased onto (1791602600026, mail `0122_change_log_retention`). RE-DERIVED
  // from the journal in the tree.
  // CLOUD 25 → 26 for `0040_account_lifecycle_notices` — the wall's notice ledger, whose PK is
  // the idempotency. Its `when` (1791328224223) is strictly above the landed maximum it was
  // rebased onto (1791328224222, cloud `0039_screener_suggest_owed`). RE-DERIVED from the
  // journal in the tree.

  // CLOUD 26 → 27 for `0041_attachment_staging_digest`: `when` 1791328224224, strictly above the
  // landed maximum it was rebased onto (0040's 1791328224223). RE-DERIVED from the journal.

  // CLOUD 27 → 28 for `0042_desktop_approval` — the approval row on `login_tokens`, renumbered
  // from 0041 at the landing because `0041_attachment_staging_digest` landed first: idx 27, `when`
  // 1791328224225, strictly above that landed maximum (1791328224224). RE-DERIVED from the
  // journal in the tree (28 entries), never the max of the two sides' 27.

  // CLOUD 28 → 29 for `0043_erased_bearers` — the erased account's token hashes: idx 28, `when`
  // 1791328224226, strictly above the landed maximum (0042's 1791328224225). RE-DERIVED.

  // CLOUD 29 → 30 for `0044_platform_signals_upstream_refused` — the sample cause a mid-walk
  // refusal writes: idx 29, `when` 1791328224227, strictly above 0043's 1791328224226. RE-DERIVED.

  // CLOUD 30 → 31 for `0046_totp_pending_replacement` (the number is provisional until the
  // migration is released) — an authenticator replacement in progress: idx 30, `when`
  // 1791328224228, strictly above 0044's 1791328224227. RE-DERIVED.

  // MAIL 125 → 126 for `0125_message_search` — the search document. Its `when`
  // (1791602600029) is strictly above the maximum at its base (1791602600028, mail
  // `0124_sync_blocked_reason_account_closed`). 126 → 127 for `0126_mailbox_erasure_done` —
  // the erasure's finish stamp, RENUMBERED from 0125 at the landing: its `when`
  // (1791602600030) is strictly above the landed maximum (1791602600029, mail
  // `0125_message_search`). 127 → 128 for `0127_mailbox_signed_out_meta` — where a signed-out
  // mailbox lives: its `when` (1791602600031) is strictly above the maximum at its base
  // (1791602600030, mail `0126_mailbox_erasure_done`). 128 → 129 for `0128_rule_person_decided`:
  // its `when` (1791602600032) is strictly above 0127's. 129 → 130 for `0129_profile_import_ask`
  // (the number is provisional until the migration is released): its `when` (1791602600033) is
  // strictly above 0128_rule_person_decided's. 130 → 131 for `0130_mailbox_sync_soft_states`
  // (numbered at the K72 landing): its `when` (1791602600034) is strictly above
  // 0129_profile_import_ask's.
  // RE-DERIVED from the journal in the tree.
  // 131 → 132 for `0131_uid_bigint` (numbered at the K73 landing): its `when` (1791602600035) is
  // strictly above 0130_mailbox_sync_soft_states's.
  // CLOUD 30 → 31 for `0045_attachment_staging_digest_validate` (numbered at the K73 landing): its
  // `when` (1791328224228) is strictly above 0044_platform_signals_upstream_refused's.
  // 132 → 133 for `0132_mailbox_sent_folder` (numbered at the K73 landing): its `when`
  // (1791602600036) is strictly above 0131_uid_bigint's.
  // 133 → 134 for `0133_screener_auto_act` (numbered at the K73 landing): its `when`
  // (1791602600037) is strictly above 0132_mailbox_sent_folder's.
  // CLOUD 31 → 32 for `0046_totp_pending_replacement` (numbered at the K73 landing): its `when`
  // (1791328224229) is strictly above 0045_attachment_staging_digest_validate's.
  // 134 → 135 for `0134_withheld_too_large` (numbered at the K74 landing): its `when`
  // (1791602600038) is strictly above 0133_screener_auto_act's.
  // 135 → 136 for `0135_organizer_parked_at`: its `when` (1791602600039) is strictly above
  // 0134_withheld_too_large's.
  // CLOUD 32 → 33 for `0047_staff_roles_and_audit` (the number is provisional until the migration
  // is released): its `when` (1791328224230) is strictly above 0046_totp_pending_replacement's.
  // 136 → 137 for `0136_screener_probe_indexes`: its `when` (1791602600040) is strictly above
  // 0135_organizer_parked_at's.
  // 137 → 138 for `0137_draft_forward_of` (renumbered from 0136 at the K78 landing): its `when`
  // (1791602600041) is strictly above 0136_screener_probe_indexes's.
  // 138 → 139 for `0138_auto_filing_undone_at`: its `when` (1791602600042) is strictly above
  // 0137_draft_forward_of's.
  // 139 → 140 for `0139_messages_arrival_order` (renumbered from 0138 at the K79 landing): its
  // `when` (1791602600043) is strictly above 0138_auto_filing_undone_at's.
  // 141 → 142 for `0141_screener_floor_version`: its `when` (1791602600045) is strictly above
  // 0140_body_tsv_bounded's.
  // 142 → 143 for `0142_sync_blocked_reason_meta_folder_full`: its `when` (1791602600046) is
  // strictly above 0141_screener_floor_version's.
  // 143 → 144 for `0143_sync_blocked_reason_meta_undeletable`: its `when` (1791602600047) is
  // strictly above 0142_sync_blocked_reason_meta_folder_full's.
  // 144 → 145 for `0144_rule_person_decided_backfill`: its `when` (1791602600048) is strictly above
  // 0143_sync_blocked_reason_meta_undeletable's.
  // 145 → 146 for `0145_press_decided_at`: its `when` (1791602600049) is strictly above
  // 0144_rule_person_decided_backfill's.
  // 146 → 147 for `0146_rule_person_decided_followup`: its `when` (1791602600050) is strictly above
  // 0145_press_decided_at's.
  // 147 → 148 for `0147_messages_open_read_at`: its `when` (1791602600051) is strictly above
  // 0146_rule_person_decided_followup's.
  // 148 → 149 for `0148_messages_sender_check`: its `when` (1791602600052) is strictly above
  // 0147_messages_open_read_at's.
  // 149 → 150 for `0149_messages_sender_check_by`: its `when` (1791602600053) is strictly above
  // 0148_messages_sender_check's.
  // 150 → 151 for `0150_list_addresses`: its `when` (1791602600054) is strictly above
  // 0149_messages_sender_check_by's.
  // 151 → 152 for `0151_mailboxes_gap_since`: its `when` is strictly above 0150_list_addresses's.
  // 152 → 153 for `0152_search_gin_pending_bounded`: its `when` (1791602600056) is strictly above
  // 0151_mailboxes_gap_since's.
  // 153 → 154 for `0153_rule_revoke_keeps_its_decisions`: its `when` (1791602600057) is strictly
  // above 0152_search_gin_pending_bounded's.
  // 154 → 155 for `0154_messages_recipient_keys`: its `when` (1791602600058) is strictly above
  // 0153_rule_revoke_keeps_its_decisions's.
  // 155 → 156 for `0155_outbound_sends_rearm`: its `when` (1791602600059) is strictly above
  // 0154_messages_recipient_keys's.
  // 156 → 157 for `0156_routing_decisions_sender_reason`: its `when` (1791602600060) is strictly
  // above 0155_outbound_sends_rearm's.
  // 157 → 158 for `0157_messages_sender_date`: its `when` (1791602600061) is strictly above
  // 0156_routing_decisions_sender_reason's.
  // 158 → 159 for `0158_mailboxes_gap_strangers`: its `when` (1791602600062) is strictly above
  // 0157_messages_sender_date's.
  // 159 → 160 for `0159_rules_settled_press_at`: its `when` (1791602600063) is strictly above
  // 0158_mailboxes_gap_strangers's.
  // 160 → 162 for `0160_folder_state_outstanding` and `0161_mailboxes_account_idx`: their `when`s
  // (1791602600064, 1791602600065) are strictly above 0159_rules_settled_press_at's, in order.
  // 162 → 163 for `0162_outbound_sends_offer_state`: its `when` (1791602600066) is strictly above
  // 0161_mailboxes_account_idx's.
  // 163 → 164 for `0163_folder_state_fresh_intent` (idx 163): its `when` (1791602600067) is strictly
  // above 0162_outbound_sends_offer_state's.
  // cloud 33 → 34 for `0048_alert_driver_gaps`: its `when` (1791328224231) is strictly above 0047's.
  // cloud 34 → 35 for `0049_alert_driver_gaps_staff_grant`: its `when` (1792235630016) is strictly
  // above 0048's.
  // cloud 35 → 36 for `0050_billing_link_notices`: its `when` (1792287004502) is strictly above 0049's.
  // cloud 36 → 37 for `0051_alert_drills`: its `when` (1792587192601) is strictly above 0050's.
  it.each([["mail", MAIL_DIR, 164], ["cloud", CLOUD_DIR, 37]] as const)(
    "%s: idx is contiguous, every tag has a file, and no tag is duplicated",
    (_name, dir, expectedEntries) => {
      const entries = journal(dir);
      // A literal count, so a journal that silently lost an entry cannot pass by being
      // internally consistent about a shorter list.
      expect(entries).toHaveLength(expectedEntries);
      expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
      expect(new Set(entries.map((e) => e.tag)).size).toBe(entries.length);
      for (const e of entries) {
        expect(existsSync(join(dir, `${e.tag}.sql`)), `${e.tag}.sql is missing`).toBe(true);
        expect(e.version).toBe("7");
      }
      // …and no .sql file is ORPHANED — present in the folder, absent from the journal, so
      // never applied and never noticed.
      const onDisk = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      expect(onDisk).toEqual(entries.map((e) => `${e.tag}.sql`).sort());
    },
  );

  /**
   * THE ORDERING DEFECT, asserted rather than hoped for.
   *
   * `dialect.migrate` applies an entry iff `Number(last.created_at) < entry.folderMillis`,
   * where `last` is the row with the greatest `created_at`. So an entry whose `when` is at or
   * below the current maximum is skipped, forever, with no error and no log line. The failure
   * is invisible offline — every test replays into an empty database where the comparison is
   * vacuous — and permanent in production.
   *
   * The two journals preserve each entry's ORIGINAL `when` from the single-journal era, which
   * is why this holds by construction rather than by care. Migration 25 will not have that
   * protection: see the READMEs.
   */
  it.each([["mail", MAIL_DIR], ["cloud", CLOUD_DIR]] as const)(
    "%s: `when` is STRICTLY increasing — an entry at or below the maximum is skipped forever",
    (_name, dir) => {
      const whens = journal(dir).map((e) => e.when);
      for (let i = 1; i < whens.length; i++) {
        expect(whens[i]!, `entry ${i} (${journal(dir)[i]!.tag}) is not above its predecessor`)
          .toBeGreaterThan(whens[i - 1]!);
      }
    },
  );

  it("the two journals may share a `when`, because they are separate tables", () => {
    // Both halves of a split legacy migration keep its original `when`. That is correct — the
    // migrator compares within ONE migrations table — and it is asserted so a future reader
    // does not "fix" it. FOUR legacy files were mixed (0003, 0006, 0021, 0023), so exactly
    // four `when` values appear in both journals.
    const shared = journal(MAIL_DIR).map((e) => e.when)
      .filter((w) => journal(CLOUD_DIR).some((e) => e.when === w));
    expect(shared).toHaveLength(4);
    expect(shared).toEqual([1785190651291, 1785197635203, 1785833686206, 1786006486206]);
  });
});

/**
 * THE CLOSURE RULE, and it now carries more weight than it was designed for.
 *
 * `drizzle-kit generate` and its snapshots were removed in this stage (see
 * `STAGE3-DB-SPLIT.md` §3a — the stale snapshots would have made the first post-split generate
 * emit `DROP TABLE` for 35 tables). With no generator, a human hand-writing into the wrong
 * folder is the ONLY remaining way a mail-domain statement reaches the Cloud journal or the
 * reverse. So this runs over the folders' CURRENT contents on every test run, not once over
 * the files the split produced — it has to govern migration 25.
 *
 * The rule is ASYMMETRIC on purpose:
 *
 *  · a MAIL statement naming ANY private object ⇒ violation. It breaks mail-first ordering
 *    AND the local invariant (the mail journal alone must build a working mail database).
 *  · a CLOUD statement DEFINING a shared object ⇒ violation. That statement belongs in the
 *    mail journal, and leaving it here means the mail schema is incomplete on its own.
 *  · a CLOUD statement merely READING a shared object ⇒ legal, and unavoidable. Every
 *    `REFERENCES public.accounts` is one, and so is `0006_email_verified_backfill`, which
 *    reads `users` to stamp it from `invites`.
 */
describe("the closure rule holds over both journals as they stand right now", () => {
  it("every table named anywhere in either journal is in the partition", () => {
    // Guards the two lists against a new table that nobody classified — which would otherwise
    // sail through both checks below by being absent from `SIDE`.
    const unknown = new Set<string>();
    for (const dir of [MAIL_DIR, CLOUD_DIR]) {
      for (const c of allChunks(dir)) {
        for (const t of namedTables(c.sql)) if (!SIDE.has(t)) unknown.add(t);
      }
    }
    expect([...unknown], "unclassified tables — add them to MAIL_TABLES or CLOUD_TABLES").toEqual([]);
    // 71 → 72 for `account_storage` (mail 0062) — the stored-body byte counter, classified
    // MAIL beside the table whose octets it counts.
    // 72 → 74 for the setup pool pair (cloud 0021), enrolled with the migrations.
    // 74 → 75 for `billing_reconciliation_runs` (cloud 0023) — the reconciliation run ledger,
    // classified CLOUD beside the billing operations it audits.
    // 75 → 76 for `folder_ops` (mail 0074) — the user-commanded folder verbs' command table,
    // classified MAIL beside the `mailbox_folders` inventory its rows are commands about: a
    // local install that grows the verbs needs its own copy, and nothing in it is billing.
    // 76 → 77 for `mailbox_oauth_device_ceremonies` (cloud 0027) — the device-code ceremony's
    // own table, CLOUD for the reason written on it in CLOUD_TABLES: it is the hosted route
    // table's surface, and a LOCAL desktop install has no accounts row to bind a ceremony to.
    // 77 → 79 for `away_replies` and `away_sender_state` (mail 0087), both MAIL — see their
    // entry in MAIL_TABLES for why the away responder's ledger and its per-correspondent throttle
    // state sit on the side a standalone install carries.
    // 79 → 82 for `credit_usage_daily`, `credit_usage_totals` and `credit_rollup_runs` (cloud
    // 0028), all three CLOUD — see their entry in CLOUD_TABLES: they are aggregates OF
    // `credit_ledger`, which is CLOUD, and a local install has no ledger to aggregate.
    // 79 → 80 for `organizer_requests` (mail 0088), MAIL — see its entry in MAIL_TABLES for why
    // a reader's outstanding decisions sit on the side a standalone install carries.
    // 80 → 83 for `billing_invoices`, `platform_costs` and `ai_usage_daily` (cloud 0029), all
    // three CLOUD — see their entry in CLOUD_TABLES, where each is argued separately because
    // `ai_usage_daily` is the one a desktop install could plausibly want and still must not have.
    // The two slices landed in the same window and this arithmetic is their sum: four tables,
    // three private and one shared, and the two halves below move independently.
    // 86 → 88 for `alert_pass_runs` and `platform_signals` (cloud 0030), both CLOUD — see their
    // entry in CLOUD_TABLES: one records a hosted driver's pass and the other holds what our
    // hosting platform served, and a standalone install has neither.
    // 88 → 89 for `outbound_send_fingerprints` (mail 0093), MAIL — see its entry in MAIL_TABLES:
    // the claim is bookkeeping about the user's own outgoing mail, and a standalone install needs
    // it for the same reason the hosted service does. Two lanes moved this literal in the same
    // window and both reasons are kept, which is the whole point of the count carrying them.
    // 89 → 90 for `mailbox_profile_mirror` (mail 0094), MAIL — see its entry in MAIL_TABLES: it is
    // the other half of `organizer_requests`'s channel, a reader's cache of a document that lives
    // in the user's own IMAP folder, and a standalone install reading a mailbox another machine
    // organizes is the primary case for it.
    // 90 → 91 for `api_faults` (cloud 0033) — the API's own 5xx record, CLOUD above.
    // 91 → 92 for `staff_audit_log` (cloud 0036) — what an operator did to a staff account, CLOUD
    // above for `staff_users`' reason: a local install has no operator and no staff table.
    // 92 → 93 for `credit_refund_obligations` (cloud 0037) — a spend that bought nothing, CLOUD
    // above: it exists only where an entitlements program does, and a local install owes nothing.
    // 93 → 95 for `unsubscribe_examined` and `unsubscribe_drain_state` (mail 0116), both MAIL:
    // the drain's per-message mark and where its window walk stopped. A device runs that pass
    // over its own store, so neither belongs to the private half.
    // 95 → 96 for `junk_rescues` (mail 0117) — the junk rescue's desired state, MAIL.
    // 97 → 98 for `account_lifecycle_notices` (cloud 0040) — the wall's notice ledger.
    // CLOUD; see its entry in CLOUD_TABLES for why a local install must not carry it.
    // 96 → 97 for `screener_suggest_owed` (cloud 0039) — the hosted worker's suggest-owed mark,
    // CLOUD; see its entry in CLOUD_TABLES for why a standalone install must not carry it.

    // 98 → 99 for `message_search` (mail 0125) — the search document, MAIL.
    // 99 → 100 for `erased_bearers` (cloud 0043) — an erased account's token hashes, CLOUD.
    // 100 → 102 for `staff_role_grants` and `staff_audit_events` (cloud 0047), both CLOUD.
    // 102 → 103 for `list_addresses` (mail 0150) — the addresses lists post as, MAIL.
    // 103 → 104 for `alert_driver_gaps` (cloud 0048) — the alert drivers' gap history, CLOUD.
    // 104 → 105 for `alert_drills` (cloud 0051) — alert drills and their acknowledgements, CLOUD.
    expect(SIDE.size).toBe(105);   // 70 → 71 for `pairing_tokens` (mail 0059); 0060 MOVED a table
    // 44 → 45 and 27 → 26 for `refresh_tokens` (mail 0060) — the first MOVE in the partition's
    // history rather than an addition, so the total stayed 71 while both halves changed together.
    expect(MAIL_TABLES).toHaveLength(57);   // 56 → 57: list_addresses (mail 0150)   // 55 → 56: message_search (mail 0125)   // 54 → 55: junk_rescues (mail 0117)   // 52 → 54: unsubscribe_examined + unsubscribe_drain_state (mail 0116)   // 51 → 52: mailbox_profile_mirror (mail 0094)   // 50 → 51: outbound_send_fingerprints (mail 0093)   // 49 → 50: organizer_requests (mail 0088)   // 47 → 49: away_replies + away_sender_state (mail 0087)   // 46 → 47: folder_ops (mail 0074)
    // 30 → 33: credit_usage_daily + credit_usage_totals + credit_rollup_runs (cloud 0028)
    // 33 → 36: billing_invoices + platform_costs + ai_usage_daily (cloud 0029)
    // 36 → 38: alert_pass_runs + platform_signals (cloud 0030)
    // 38 → 39: `api_faults` (cloud 0033).
    // 39 → 40: `staff_audit_log` (cloud 0036).
    // 40 → 41: `credit_refund_obligations` (cloud 0037).
    // 41 → 42: `screener_suggest_owed` (cloud 0039).
    // 42 → 43: account_lifecycle_notices (cloud 0040)
    // 43 → 44: erased_bearers (cloud 0043)
    // 44 → 46: staff_role_grants + staff_audit_events (cloud 0047)
    // 46 → 47: alert_driver_gaps (cloud 0048)
    // 47 → 48: alert_drills (cloud 0051)
    expect(CLOUD_TABLES).toHaveLength(48);   // 29 → 30: mailbox_oauth_device_ceremonies (cloud 0027)
  });

  it("NO mail statement names a private object — so mail-first is sound, not assumed", () => {
    const violations: string[] = [];
    for (const c of allChunks(MAIL_DIR)) {
      for (const t of namedTables(c.sql)) {
        if (SIDE.get(t) === "cloud") violations.push(`${c.tag} chunk ${c.i} names private "${t}"`);
      }
    }
    expect(violations, "the mail journal cannot run first, or run alone, with these").toEqual([]);
  });

  /**
   * THE ADOPTED TABLE — the one arbitration the DDL rule carries, pinned by exact chunk.
   *
   * `refresh_tokens` moved to the mail half in mail 0060 (Phase 3 paired devices rotate
   * against the store that serves them), and the cloud journal's 0000 still CREATEs it, because
   * those five statements are byte-frozen legacy history: deleting them would fail the
   * permutation oracle below, which is the record that the single-journal era happened, and a
   * database that ran the legacy path is a database they already built. Every one of them is
   * IF-NOT-EXISTS or duplicate_object-guarded, so wherever the mail journal has run first they
   * are no-ops — the property the rule protects ("the mail schema must be whole alone") HOLDS,
   * because mail 0060 creates the table.
   *
   * Pinned by `${tag}#${chunk}` so a NEW cloud statement touching `refresh_tokens` — or these
   * five drifting — still stops the suite. A second adopted table is a decision somebody takes
   * on purpose, with a reason, exactly like the 0006 arbitration below.
   */
  const ADOPTED_BY_MAIL: ReadonlySet<string> = new Set([
    "0000_auth_ceremony#6",    // CREATE TABLE IF NOT EXISTS "refresh_tokens"
    "0000_auth_ceremony#14",   // guarded FK user_id → users.id (duplicate_object caught)
    "0000_auth_ceremony#15",   // guarded FK session_id → sessions.id (duplicate_object caught)
    "0000_auth_ceremony#22",   // CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx
    "0000_auth_ceremony#23",   // CREATE INDEX IF NOT EXISTS refresh_tokens_session_idx
  ]);

  it("NO cloud statement performs DDL on a shared object — the mail schema must be whole alone", () => {
    const violations: string[] = [];
    for (const c of allChunks(CLOUD_DIR)) {
      if (ADOPTED_BY_MAIL.has(`${c.tag}#${c.i}`)) continue;
      for (const t of ddlTables(c.sql)) {
        if (SIDE.get(t) === "mail") violations.push(`${c.tag} chunk ${c.i} alters shared "${t}"`);
      }
    }
    expect(violations, "these belong in the mail journal — the mail schema is incomplete without them")
      .toEqual([]);
  });

  it("the adopted-table pin is load-bearing — every pinned chunk exists and targets refresh_tokens", () => {
    // Without this, a renumbering of 0000's chunks (a statement inserted above them) would
    // silently move the exemption onto five UNRELATED statements while the refresh_tokens DDL
    // started failing the rule — or worse, stopped being checked at all.
    const byKey = new Map(allChunks(CLOUD_DIR).map((c) => [`${c.tag}#${c.i}`, c]));
    for (const key of ADOPTED_BY_MAIL) {
      const c = byKey.get(key);
      expect(c, `${key} is pinned but no such chunk exists`).toBeDefined();
      expect(ddlTables(c!.sql), `${key} no longer targets refresh_tokens`).toEqual(["refresh_tokens"]);
    }
  });

  /**
   * The one statement the seam rule has to ARBITRATE, pinned.
   *
   * `0023`'s backfill WRITES `users` (shared) by READING `invites` (private). It cannot go in
   * the mail journal — `invites` does not exist there — and it is not DDL, so it does not make
   * the mail schema incomplete. It resolves to CLOUD because it reads a private table, which is
   * the seam rule working rather than an exception to it.
   *
   * Pinned as exactly one so a second cross-half statement is a decision somebody takes on
   * purpose, with a reason, rather than something that happens.
   */
  it("exactly ONE cloud statement writes a shared table, and only because it reads a private one", () => {
    // The ADOPTED chunks are DDL, arbitrated above; this test is about the one cross-half DATA
    // statement, so they are subtracted here for the reason already argued at their pin.
    const crossHalf = allChunks(CLOUD_DIR).filter((c) =>
      !ADOPTED_BY_MAIL.has(`${c.tag}#${c.i}`)
      && writtenTables(c.sql).some((t) => SIDE.get(t) === "mail"));
    expect(crossHalf.map((c) => `${c.tag}#${c.i}`)).toEqual(["0006_email_verified_backfill#0"]);
    // …and it is legal ONLY because of the private read. Without one it would belong in mail.
    const c = crossHalf[0]!;
    expect(namedTables(c.sql).filter((t) => SIDE.get(t) === "cloud")).toEqual(["invites"]);
    expect(ddlTables(c.sql), "a cross-half statement may never be DDL").toEqual([]);
  });

  /**
   * THE POSITIVE CONTROL. A rule that has never been seen to reject anything is a rule nobody
   * knows the state of, and this repository has shipped a guard that printed a violation and
   * then reported success. The detectors are run against statements that WOULD be violations,
   * so "no violations" above means the rule looked.
   */
  it.each([
    ['CREATE TABLE IF NOT EXISTS "credit_ledger" ("id" bigserial);', "credit_ledger"],
    ['ALTER TABLE "invites" ADD COLUMN "x" text;', "invites"],
    ['CREATE INDEX IF NOT EXISTS "i" ON "billing_events" USING btree ("type");', "billing_events"],
    ['DROP INDEX IF EXISTS "users_email_idx";', "users"],
  ])("detects %s as DDL on %s", (stmt, table) => {
    expect(ddlTables(stmt)).toContain(table);
  });

  it("does NOT treat a data backfill as DDL — that distinction is what makes 0006 legal", () => {
    const backfill = 'UPDATE "waitlist" SET "tier" = \'solo\';';
    expect(ddlTables(backfill)).toEqual([]);
    expect(writtenTables(backfill)).toEqual(["waitlist"]);
  });

  it("refuses a DROP INDEX whose owning table nobody has declared", () => {
    // The index-owner map is how a `DROP INDEX` is attributed to a side at all. An unlisted index
    // name must stop the suite rather than be silently attributed to nothing.
    expect(() => ddlTables('DROP INDEX IF EXISTS "some_new_index";'))
      .toThrow(/add its owning table to DROPPED_INDEX_OWNER/);
  });

  it("detects a private table reached only through a foreign key or a subquery", () => {
    const fk = 'ALTER TABLE "messages" ADD CONSTRAINT "x" FOREIGN KEY ("a") REFERENCES "public"."invites"("id");';
    expect(ddlTables(fk)).toEqual(["messages"]);
    expect(namedTables(fk)).toContain("invites");
    const sub = 'UPDATE "users" SET "x" = 1 WHERE EXISTS (SELECT 1 FROM "credit_ledger");';
    expect(namedTables(sub)).toContain("credit_ledger");
  });

  it("does not fire on a table name that appears only in a comment", () => {
    // The authored headers discuss the other half by name on purpose — a reader of the mail
    // journal is told where the Cloud half of a split migration went. A checker that counted
    // those would make honest cross-references impossible.
    const prose = '-- the other half lives beside "invites" in the cloud journal\nALTER TABLE "users" ADD COLUMN "z" text;';
    expect(namedTables(prose)).toEqual(["users"]);
  });
});

/**
 * PROPERTY 1 — nothing was lost and nothing was invented.
 *
 * Compares the pre-split journal's statements against the two new journals' statements as
 * MULTISETS, normalised for comments and whitespace (the four authored headers re-home prose
 * between the halves, deliberately, so the comparison has to ignore comments — and the SQL
 * itself was never rewritten, so it does not need to ignore anything else).
 *
 * A missing statement here is the failure with no alarm: production already ran the original
 * journal, so it keeps the index or trigger, and only databases built afterwards lack it.
 */
describe("the split is a permutation of the pre-split journal", () => {
  const normalise = (s: string): string => stripComments(s).replace(/\s+/g, " ").trim();

  /** `skipHashes` drops individual STATEMENTS, never whole files — see POST_SPLIT_STATEMENTS. */
  function multiset(dirs: string[], skipHashes: ReadonlySet<string> = new Set()): Map<string, number> {
    const m = new Map<string, number>();
    for (const dir of dirs) {
      for (const c of allChunks(dir)) {
        const n = normalise(c.sql);
        if (!n || skipHashes.has(hashOf(n))) continue;
        m.set(n, (m.get(n) ?? 0) + 1);
      }
    }
    return m;
  }

  it("every pre-split statement appears exactly once across the two journals", () => {
    const before = multiset([LEGACY_DIR]);
    const after = multiset([MAIL_DIR, CLOUD_DIR], POST_SPLIT_HASHES);

    // A literal, so a run where the walker silently found nothing cannot pass.
    expect(before.size).toBe(155);

    const lost = [...before.keys()].filter((k) => !after.has(k));
    const invented = [...after.keys()].filter((k) => !before.has(k));
    expect(lost.map((s) => s.slice(0, 120)), "statements the surgery DROPPED").toEqual([]);
    expect(invented.map((s) => s.slice(0, 120)), "statements the surgery INVENTED").toEqual([]);

    const miscounted = [...after.entries()]
      .filter(([k, n]) => n !== before.get(k))
      .map(([k, n]) => `${n}x (was ${before.get(k)}x) ${k.slice(0, 90)}`);
    expect(miscounted, "a statement was duplicated or dropped a copy").toEqual([]);
    expect(after.size).toBe(before.size);
  });

  it("every exempted statement is STILL THERE — a deletion inside 0021 must fail", () => {
    // THE HOLE THIS CLOSES. Exempting by TAG waved through whatever the file happened to
    // contain: delete the dedup prelude and every test still passed, because a deletion adds
    // nothing for an "invention" check to see and no fixture has duplicates to miss it. The
    // first live database with a duplicate then fails the index build mid-deploy.
    const present = new Set<string>();
    for (const c of [...allChunks(MAIL_DIR), ...allChunks(CLOUD_DIR)]) {
      const n = normalise(c.sql);
      if (n) present.add(hashOf(n));
    }
    for (const [tag, hashes] of Object.entries(POST_SPLIT_STATEMENTS)) {
      for (const h of hashes) {
        expect(present.has(h), `${tag}: exempted statement ${h} is no longer in the journal — ` +
          "it was deleted or edited. Re-review the migration, then update the hash.").toBe(true);
      }
    }
  });

  it("nothing EXTRA hides in a post-split file — an appended statement must fail", () => {
    // The other direction: appending destructive DML to an already-exempted tag was invisible
    // while the exemption was per-file. Every statement in a post-split migration must be
    // named, so adding one stops the suite until somebody looks at it.
    for (const dir of [MAIL_DIR, CLOUD_DIR]) {
      for (const c of allChunks(dir)) {
        if (!POST_SPLIT_TAGS.has(c.tag)) continue;
        const n = normalise(c.sql);
        if (!n) continue;
        expect(POST_SPLIT_HASHES.has(hashOf(n)),
          `${c.tag} statement #${c.i} (${hashOf(n)}) is not in POST_SPLIT_STATEMENTS: ` +
          `${n.slice(0, 90)}`).toBe(true);
      }
    }
  });

  it("the exemption is load-bearing — without it these ARE the oracle's inventions", () => {
    // If this ever comes back empty the list is dead weight and should be deleted rather
    // than carried as decoration.
    const before = multiset([LEGACY_DIR]);
    const unscoped = multiset([MAIL_DIR, CLOUD_DIR]);
    const wouldBeInvented = [...unscoped.keys()].filter((k) => !before.has(k));
    // One hash per exempted statement, and a list that stops matching its own arithmetic is
    // dead weight. The figure that stood here had drifted from the set it claimed to count.
    expect(wouldBeInvented.length).toBe(POST_SPLIT_HASHES.size);
  });

  it("the pre-split journal is 23 entries — it is the oracle and the adoption evidence", () => {
    // `STAGE3-DB-SPLIT.md` §7: the legacy journal and its `drizzle.__drizzle_migrations` table
    // are what prove a production database took the pre-split path. Deleting this folder would
    // remove both the proof above and the basis for baseline adoption.
    // TWENTY-THREE, not twenty-four: `0018_billing` was the billing schema expressed in SQL,
    // and that machinery is no longer part of this server. `LEGACY_JOURNAL_WHENS` in
    // `baseline.ts` still names TWENTY-FOUR whens and must — it is the set a pre-split database
    // HAS, which no deletion here can change, and adoption compares against what it holds.
    const entries = journal(LEGACY_DIR);
    expect(entries).toHaveLength(23);
    expect(entries.at(-1)!.when).toBe(1786006486206);
  });
});
