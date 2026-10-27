import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE TYPESCRIPT SPLIT, CHECKED AGAINST THE JOURNAL — one partition, not two opinions.
 *
 * `journal-split.test.ts` governs the SQL: 41 mail tables in `@ohmail/db-mail`'s journal, 22
 * private ones in `drizzle-cloud`, and the closure rule that lets the mail half run first and
 * alone. This file governs the TypeScript that models them, and its whole job is to make sure
 * the two never disagree.
 *
 * The expectation is DERIVED FROM THE JOURNALS rather than restated here. A second hand-written
 * list would be a second thing to keep right, and the failure mode of the pair drifting is the
 * one that matters: a table declared on the mail side whose `CREATE TABLE` is in the cloud
 * journal produces a desktop install whose code expects a table its database will never have.
 *
 * ── WHY THE SPLIT EXISTS AT ALL ───────────────────────────────────────────────────────────
 *
 * The desktop engine's sources are published. One `schema.ts` thousands of lines long meant its bundle
 * carried `password_hash`, `token_hash` and `credit_ledger` column definitions — publishing
 * those is one-way, and no amount of "nothing reads them" makes the names not disclosure.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "src");
const MAIL_JOURNAL_DIR = join(HERE, "..", "..", "db-mail", "drizzle");
const CLOUD_JOURNAL_DIR = join(HERE, "..", "drizzle-cloud");

const read = (p: string): string => readFileSync(p, "utf8");

/** The tables a schema module DECLARES, by their SQL name. */
function declaredTables(file: string): Set<string> {
  return new Set([...read(join(SRC, file)).matchAll(/pgTable\("([a-z_]+)"/g)].map((m) => m[1]!));
}

/** The tables a journal CREATES. The migration is the fact; the TypeScript is the model of it. */
function createdTables(dir: string): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
    for (const m of read(join(dir, f)).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([a-z_]+)"/gi)) {
      out.add(m[1]!);
    }
  }
  return out;
}

const sorted = (s: Set<string>): string[] => [...s].sort();

describe("the schema split matches the journal split", () => {
  it("every mail table is declared on the mail side, and no cloud table is", () => {
    expect(sorted(declaredTables("schema-mail.ts"))).toEqual(sorted(createdTables(MAIL_JOURNAL_DIR)));
  });

  it("every cloud table is declared on the cloud side, and no mail table is", () => {
    // THE ONE ADOPTED TABLE: `refresh_tokens` moved to the mail half (mail 0060, Phase 3 —
    // paired devices rotate against the store that serves them), but the cloud journal's 0000
    // still CREATEs it, byte-frozen, for the legacy path (`journal-split.test.ts` pins the
    // arbitration chunk by chunk). So the cloud journal's CREATE set legitimately exceeds the
    // cloud schema module by exactly this table — subtracted here by name, so a SECOND
    // undeclared cloud creation still fails.
    const created = createdTables(CLOUD_JOURNAL_DIR);
    created.delete("refresh_tokens");
    expect(sorted(declaredTables("schema-cloud.ts"))).toEqual(sorted(created));
    expect(declaredTables("schema-mail.ts").has("refresh_tokens"),
      "the adopted table must live on the mail side — otherwise it is simply undeclared").toBe(true);
  });

  /**
   * Literals, for the same reason `journal-split.test.ts` keeps its counts as literals: a split
   * that silently LOST a table must not pass by being internally consistent about a shorter list.
   * Both checks above compare two derived sets, and two sets that lost the same table still match.
   */
  it("the counts are the ruled ones — 54 shared, 25 private", () => {
    // 43 since mail 0051 added `away_responder_sent`, the away responder's at-most-once record.
    // MAIL and not by analogy: it is keyed by the account and by a correspondent's address, written
    // only by the pass that reads `away_responders`, and a local install that ever grows a responder
    // needs its own copy or it would answer everybody a second time. Its per-table justification is
    // in `journal-split.test.ts`'s `MAIL_TABLES`, which is the single source of truth for the
    // partition; this literal only counts.
    // 43 → 44 for mail 0059's `pairing_tokens` — the pairing-token lifecycle (first-boot setup
    // token, family invites, QR device pairing). MAIL because a token is redeemed against the
    // server that will serve the resulting session and the desktop-as-host arm runs the mail
    // journal only; NOT the identity ceremony, which stays private. Per-table justification in
    // `MAIL_TABLES`, as above.
    // 44 → 45 for mail 0060's `refresh_tokens` — MOVED from the cloud half, not added: QR device
    // pairing gives the desktop-as-host tier bearer pairs whose refresh families rotate against
    // the local store, the same argument that put `sessions`/`devices`/`pairing_tokens` on this
    // side. The identity ceremony (passwords, login tokens, factors, PKCE codes) stays private.
    // 45 → 46 for mail 0062's `account_storage` — the stored-body byte counter, MAIL beside
    // the table whose octets it counts; inert bookkeeping where no managed cap is wired. The
    // CAP column itself is cloud (`billing_subscriptions.storage_bytes_limit`), so the private
    // count below does not move.
    // 46 → 47 for mail 0074's `folder_ops` — the user-commanded folder verbs' command table,
    // MAIL beside the `mailbox_folders` inventory its rows are commands about: a local install
    // that grows the verbs needs its own copy, and nothing in it is billing. Per-table
    // justification in `MAIL_TABLES`, as above.
    // 47 → 49 for mail 0087's `away_replies` and `away_sender_state` — the away responder's
    // ledger and its per-correspondent throttle state. MAIL on `away_responder_sent`'s reasoning
    // at the top of this block, with one addition of its own: unlike 0051's record, these two are
    // read by a STANDALONE install, because the responder's pass now runs in the desktop engine's
    // own drain. A local install that answers its own mail must carry its own reservation and its
    // own throttle state or it would answer every correspondent a second time — which is exactly
    // the argument that put `away_responder_sent` on this side, load-bearing now rather than
    // anticipatory. Per-table justification in `MAIL_TABLES`, as above.
    // 49 → 50 for mail 0088's `organizer_requests` — a reader's outstanding decisions. MAIL, and
    // the clearest case in this block: the row is bookkeeping about a message in the user's own
    // IMAP mailbox, written and read only by the install that made the decision, and a STANDALONE
    // install reading a mailbox another machine organizes is the primary case it exists for.
    // Per-table justification in `MAIL_TABLES`, as above.
    // 50 → 51 for mail 0093's `outbound_send_fingerprints` — the account's claim on the content of
    // a send. MAIL on `outbound_sends`'s reasoning: it is bookkeeping about the user's own outgoing
    // mail, and a standalone install needs it for the same reason the hosted service does, since
    // the idempotency key it would otherwise rely on belongs to the client. Per-table justification
    // in `MAIL_TABLES`, as above.
    // 51 → 52 for mail 0094's `mailbox_profile_mirror` — a reader's copy of the configuration
    // document the organizer publishes into `ohmail/_meta`. MAIL, and it is the other half of
    // `organizer_requests`'s channel on that table's own reasoning: the row caches a document that
    // lives in the user's own mailbox, is read by the install that is NOT organizing so its
    // settings panes show the holder's configuration rather than a local row nothing applies, and
    // a standalone desktop or phone reading a mailbox another machine organizes is the primary
    // case for it. Per-table justification in `MAIL_TABLES`, as above.
    // 52 → 54: `unsubscribe_examined` and `unsubscribe_drain_state` (mail 0116), the unsubscribe
    // drain's per-message mark and where its window walk stopped. MAIL, and not a close call: a
    // standalone install runs that pass over its own store, so without them a device re-reads a
    // list it has already left at every tick. Per-table justification in `MAIL_TABLES`; this
    // literal only counts. The private count below does not move.
    // 54 → 55 for mail 0117's `junk_rescues` — the junk rescue's desired state. MAIL, and
    // structurally so: the row is a command about a message in the user's own IMAP Junk folder,
    // recorded by the door they pressed and executed by whichever install organizes that mailbox
    // — the hosted worker, a desktop engine or a standalone phone, all running the same pass.
    // Per-table justification in `MAIL_TABLES`, as above.

    // 55 → 56 for mail 0125's `message_search` — a message's own words, MAIL because every install
    // that stores the message builds and searches it. Per-table justification in `MAIL_TABLES`.
    // 56 → 57 for mail 0150's `list_addresses` — read by every store's own gate, MAIL. Per-table
    // justification in `MAIL_TABLES`.
    // 57 → 58 for mail 0170's `outbound_sent_copies` — a delivered send's owed Sent copy, MAIL.
    expect(declaredTables("schema-mail.ts").size).toBe(58);
    // 25 since cloud 0009 put `mailbox_oauth_ceremonies` and `oauth_provider_config` on the
    // private half — the OAuth ceremony store and the one Entra registration this deployment
    // signs with. Both are Cloud-only by construction: the ceremony is a ninety-second row in
    // a hosted consent flow, and the registration holds a secret of OURS rather than an
    // account's, so neither may ever be declared on the mail side a local install migrates.
    //
    // Bumping this literal is a deliberate act, which is the whole reason it is a literal: the
    // two derived comparisons above still agree with each other when a table goes missing from
    // BOTH sides, so this count is the only assertion that notices a table quietly leaving the
    // schema.
    // 25 → 26 for cloud 0015's `attachment_staging` — the ticket half of the hosted send's
    // direct-upload transport, and Cloud-only for the same kind of structural reason: a local
    // install runs the send handler in the same process as its own SMTP dial, so there is no
    // request body to stage around and no object storage to stage into.
    // 26 → 27 for cloud 0016's `ai_attempt_claims` — the exclusive claim the AI spend gate holds
    // while a paid model call is in flight, and Cloud-only for the most structural reason on this
    // list: it exists to coordinate METERED work, and a local install has no ledger, no
    // subscription and no gate to coordinate. Its auto-suggest pass declares itself unmetered and
    // takes no claim at all, so on the mail side this would be a table nothing can ever write to.
    // 27 → 26 for mail 0060: `refresh_tokens` left this side — the first MOVE in the partition's
    // history, so this literal and the mail one above change together and the total holds at 71.
    // 29 → 30 for cloud 0027's `mailbox_oauth_device_ceremonies` — the DEVICE-CODE ceremony's own
    // table, beside `mailbox_oauth_ceremonies` on this half and Cloud-only for the same kind of
    // structural reason: it is an account-bound, server-side row polled through the hosted route
    // table, and a LOCAL desktop install has no accounts row to bind one to and no server-side
    // ceremony to poll (its own door is the loopback listener, which writes no row anywhere). A
    // separate table rather than columns on the redirect ceremony because that one's PKCE verifier
    // is NOT NULL and this flow has no verifier, and because the two have opposite consumption
    // disciplines. Per-table justification in `journal-split.test.ts`'s `CLOUD_TABLES`, as above.
    // 30 → 33 for cloud 0028's `credit_usage_daily`, `credit_usage_totals` and
    // `credit_rollup_runs`. All three PRIVATE, and not by analogy: they are aggregates OF
    // `credit_ledger`, which is private, and a local install has no ledger to aggregate — no
    // account, no subscription, no metered spend and no worker to run the pass that writes them.
    // Their per-table justification is in `journal-split.test.ts`'s `CLOUD_TABLES`, which is the
    // single source of truth for the partition; this literal only counts.
    // 33 → 36 for cloud 0029's `billing_invoices`, `platform_costs` and `ai_usage_daily`. All
    // three PRIVATE, and `ai_usage_daily` is the one that has to be argued rather than assumed:
    // a desktop install DOES make metered model calls, on its owner's own key against its owner's
    // own bill, with no ledger and no margin to measure. This table answers "what did serving our
    // customers cost US", which only the hosted service can ask — and keeping it here is what
    // stops `packages/core`'s AI client from ever naming it. Per-table justification in
    // `journal-split.test.ts`'s `CLOUD_TABLES`; this literal only counts.
    // 36 → 38 for cloud 0030's `alert_pass_runs` and `platform_signals`. Both PRIVATE, and
    // neither is a close call: `alert_pass_runs` records that one of the two HOSTED alert
    // drivers completed a pass (a desktop install runs neither), and `platform_signals` holds
    // what OUR hosting platform served for OUR projects, which is `platform_costs`'s argument
    // one line up in the same words. Per-table justification in `journal-split.test.ts`'s
    // `CLOUD_TABLES`; this literal only counts.
    // 38 → 22: the SIXTEEN metering tables left this schema with the machinery that read them
    // (the customer, the subscription, the events, the reconciliation runs, the invoices, the
    // balances, the ledger, its two usage aggregates and its run ledger, the attempt claims, the
    // two setup-pool tables, the platform costs, the AI usage day and the suspensions). The
    // shared count above does not move, which is the arithmetic saying nothing crossed sides.
    // 22 → 23: `api_faults` (cloud 0033), the API's own 5xx record, declared beside
    // `platform_signals`. The shared count does not move.
    // 23 → 24: `staff_audit_log` (cloud 0036), the record the second-factor recovery leaves,
    // declared beside `staff_sessions`. The shared count does not move.
    // 24 → 25: `credit_refund_obligations` (cloud 0037), what this server owes somebody whose
    // spend bought nothing. The shared count does not move, which is the arithmetic saying the
    // table was ADDED to the private half rather than a shared one having crossed — and it is
    // private for the retired ledger's own reason: no entitlements program, nothing to owe.
    // 25 → 26: `screener_suggest_owed` (cloud 0039) — the suggest-owed mark; per-table
    // justification in `journal-split.test.ts`'s CLOUD_TABLES, as above.

    // 26 → 27: `account_lifecycle_notices` (cloud 0040) — the wall's notice ledger; per-table
    // justification in `journal-split.test.ts`'s CLOUD_TABLES, as above. The shared count does
    // not move: only the managed deployment has a plane to read or a subscription to end.
    // 27 → 28: `erased_bearers` (cloud 0043) — an erased account's token hashes; per-table
    // justification in `journal-split.test.ts`'s CLOUD_TABLES. The shared count does not move.
    // 28 → 30: `staff_role_grants` and `staff_audit_events` (cloud 0047) — staff roles and the
    // staff audit; per-table justification in `journal-split.test.ts`'s CLOUD_TABLES.
    // 30 → 31: `alert_driver_gaps` (cloud 0048) — the alert drivers' gap history, as above.
    // 31 → 32: `alert_drills` (cloud 0051) — alert drills and their acknowledgements, as above.
    // 32 → 33: `connect_attempts` (cloud 0054) — how connecting a mailbox ended, as above.
    expect(declaredTables("schema-cloud.ts").size).toBe(33);
  });

  /**
   * THE DIRECTION RULE, and it is the one that keeps the desktop bundle honest.
   *
   * The mail half must stand alone: it is what a local install migrates and all its database
   * holds. One `import { … } from "./schema-cloud.js"` in that file — for a foreign key, for a
   * shared enum, for convenience — puts the whole private half back into the engine's import
   * closure, and nothing at runtime would notice, because the tables it names are simply never
   * queried there.
   *
   * The reverse is legal and is used: `schema-cloud.ts` imports `accounts`, `users` and
   * `sessions`, exactly as every `REFERENCES public.accounts` in the cloud journal reaches into
   * the mail one.
   */
  it("the mail half imports nothing from the cloud half", () => {
    const mail = read(join(SRC, "schema-mail.ts"));
    expect(mail).not.toMatch(/from\s+"\.\/schema-cloud/);
    expect(mail).not.toMatch(/from\s+"\.\/schema\.js"/);
    // …and the cloud half really does depend on the mail half, so the test above is asserting a
    // direction rather than an absence of imports in general.
    expect(read(join(SRC, "schema-cloud.ts"))).toMatch(/from\s+"\.\/schema-mail\.js"/);
  });

  /**
   * THE CONSUMER THE SPLIT WAS DONE FOR.
   *
   * `apps/sidecar/src/db.ts` is the desktop engine's database. It must reach the mail half by a
   * path that resolves to the mail half ALONE — `@trafficflow/db/mail` — and never the root
   * barrel, which re-exports both and would put the private half back in the bundle while every
   * test still passed.
   */
  it("the desktop engine's database imports the mail schema and not the barrel", () => {
    const db = read(join(HERE, "..", "..", "..", "apps", "sidecar", "src", "db.ts"));
    // The IMPORTS, not the prose. That file's header explains at length why the cloud pass was
    // removed and names both `JOURNALS` and the cloud journal to do it — a check that read the
    // whole file would forbid the explanation along with the code.
    const imports = [...db.matchAll(/^import .*$/gm)].map((m) => m[0]).join("\n");
    expect(imports).toMatch(/import \{ mailSchema \} from "@trafficflow\/db\/mail"/);
    expect(imports).not.toMatch(/from "@trafficflow\/db";/);
    expect(imports).not.toMatch(/\bCLOUD_JOURNAL\b/);
    expect(imports).not.toMatch(/\bJOURNALS\b/);
    // And the migration loop really is the mail one, at the call rather than at the import.
    expect(db).toMatch(/migrationsFolder: MAIL_JOURNAL\.dir/);
  });

  /**
   * The subpath has to be declared, or `@trafficflow/db/mail` resolves to nothing at runtime and
   * the import above is a build error nobody sees until the engine is bundled.
   */
  it("the mail subpath is exported by the package", () => {
    const pkg = JSON.parse(read(join(HERE, "..", "package.json"))) as {
      exports: Record<string, string | Record<string, string>>;
    };
    // The mail half alone under every condition, as source or as its built twin; never the barrel.
    const mail = pkg.exports["./mail"];
    const targets = typeof mail === "string" ? [mail] : Object.values(mail ?? {});
    expect(targets.length, "no ./mail subpath").toBeGreaterThan(0);
    for (const t of targets) expect(t).toMatch(/^\.\/(?:src\/schema-mail\.ts|dist\/schema-mail\.js)$/);
  });
});
