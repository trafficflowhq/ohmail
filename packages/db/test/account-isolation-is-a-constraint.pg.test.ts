import { randomUUID, randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * ACCOUNT ISOLATION IS REFUSED BY THE DATABASE, NOT REMEMBERED BY CALLERS (the "Account isolation is absolute, and it binds staff too" invariant).
 *
 * Every row below is legal to a single-column foreign key and illegal to the invariant: the parent
 * row exists, and it belongs to somebody else. Before the composite keys the store ACCEPTS it, so
 * one wrong `accountId` in one service put another account's mail under this account's scope and
 * nothing said so. The refusal asked for here is the database's own, with no caller involved.
 *
 * One audited pair is deliberately absent, and its own case would have passed: a key on
 * `outbound_send_fingerprints.mailbox_id` makes every send take a KEY SHARE lock on the mailbox
 * row, and production holds that row FOR UPDATE in five places — so the send would wait behind a
 * stand-down or a dedup. Its account is pinned through `send_id` instead.
 *
 * Each case plants its child under account B with EVERY reference pointing at B's own fixture
 * except the one under test, which points at A's. That isolates the pair: a green here names the
 * key that bit. Each case carries its positive control — the same row, wholly under B — because a
 * refusal rule that refuses everything measures nothing.
 */

const DB_URL = PG_TEST_URL;
const HAVE_PG = await realPgAvailable(DB_URL);

/** One complete parent fixture under one account. Every id this file plants a child against. */
interface Fixture {
  accountId: string;
  mailboxId: string; folderId: string; threadId: string; messageId: string;
  /** A SECOND mailbox and its folder, under the same account — the mailbox-scoped key's subject. */
  mailboxTwoId: string; folderTwoId: string;
  contactId: string; tagId: string; draftId: string; sendId: string;
  decisionId: string; ruleId: string; workflowId: string;
  userId: string; deviceId: string; sessionId: string;
}

/** Resolves a fixture key to the account that owns it FOR THIS CASE — A for the pair under test. */
type Pick = (k: keyof Fixture) => string;

interface Case {
  /** The audit's own pair id, so a red here names a row of the table. */
  id: string;
  table: string;
  /** The reference this case makes foreign. */
  foreign: keyof Fixture;
  /**
   * When set, the foreign arm stays INSIDE the account and takes this key instead. Only the
   * mailbox-scoped key has such a case: its subject is one account's two mailboxes, and resolving
   * against the other account would measure the account key sitting beside it.
   */
  within?: keyof Fixture;
  row(p: Pick, own: Fixture, n: number): Record<string, unknown>;
}

const hex64 = () => randomBytes(32).toString("hex");
const future = () => new Date(Date.now() + 3_600_000).toISOString();

const CASES: readonly Case[] = [
  // ── messages and its neighbours ────────────────────────────────────────────────────────────
  { id: "messages~mailboxes", table: "messages", foreign: "mailboxId",
    row: (p, o, n) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), body_hash: "h",
      dedup_key: `iso:${n}:${randomUUID()}` }) },
  { id: "messages~threads", table: "messages", foreign: "threadId",
    row: (p, o, n) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), thread_id: p("threadId"),
      body_hash: "h", dedup_key: `iso:${n}:${randomUUID()}` }) },
  { id: "message_instances~mailboxes", table: "message_instances", foreign: "mailboxId",
    row: (p, o, n) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), message_id: p("messageId"),
      folder: `iso-${n}`, uidvalidity: 1, uid: n, is_primary: false }) },
  { id: "message_instances~messages", table: "message_instances", foreign: "messageId",
    row: (p, o, n) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), message_id: p("messageId"),
      folder: `iso-${n}`, uidvalidity: 1, uid: n, is_primary: false }) },
  { id: "message_failures~mailboxes", table: "message_failures", foreign: "mailboxId",
    row: (p, o, n) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), folder: `iso-${n}`,
      uidvalidity: 1, uid: n, code: "unclassified" }) },
  { id: "folder_ops~mailboxes", table: "folder_ops", foreign: "mailboxId",
    row: (p, o) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), folder_id: p("folderId"),
      op: "create" }) },
  { id: "folder_ops~folders~mailboxes", table: "folder_ops", foreign: "folderId",
    row: (p, o) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), folder_id: p("folderId"),
      op: "create" }) },
  { id: "routing_decisions~messages", table: "routing_decisions", foreign: "messageId",
    row: (p, o) => ({ account_id: o.accountId, message_id: p("messageId"), input_provenance: "iso",
      destination: "inbox", status: "applied" }) },
  { id: "routing_decisions~rules", table: "routing_decisions", foreign: "ruleId",
    row: (p, o) => ({ account_id: o.accountId, message_id: p("messageId"), matched_rule_id: p("ruleId"),
      input_provenance: "iso", destination: "inbox", status: "applied" }) },
  { id: "approvals~messages", table: "approvals", foreign: "messageId",
    row: (p, o) => ({ account_id: o.accountId, message_id: p("messageId"), kind: "iso", action: "iso" }) },
  { id: "approvals~routing_decisions", table: "approvals", foreign: "decisionId",
    row: (p, o) => ({ account_id: o.accountId, routing_decision_id: p("decisionId"), kind: "iso",
      action: "iso" }) },
  { id: "message_states~messages", table: "message_states", foreign: "messageId",
    row: (p, o) => ({ account_id: o.accountId, message_id: p("messageId") }) },
  { id: "tracker_events~messages", table: "tracker_events", foreign: "messageId",
    row: (p, o) => ({ account_id: o.accountId, message_id: p("messageId"), kind: "iso" }) },
  { id: "attachments~messages", table: "attachments", foreign: "messageId",
    row: (p, o) => ({ account_id: o.accountId, message_id: p("messageId"), content_type: "text/plain" }) },
  { id: "message_tags~messages", table: "message_tags", foreign: "messageId",
    row: (p, o) => ({ account_id: o.accountId, message_id: p("messageId"), tag_id: p("tagId") }) },
  { id: "message_tags~tags", table: "message_tags", foreign: "tagId",
    row: (p, o) => ({ account_id: o.accountId, message_id: p("messageId"), tag_id: p("tagId") }) },
  { id: "unsubscribe_records~mailboxes", table: "unsubscribe_records", foreign: "mailboxId",
    row: (p, o, n) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), message_id: p("messageId"),
      list_key: `iso-${n}-${randomUUID()}`, state: "claimed" }) },
  { id: "unsubscribe_records~messages", table: "unsubscribe_records", foreign: "messageId",
    row: (p, o, n) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), message_id: p("messageId"),
      list_key: `iso-${n}-${randomUUID()}`, state: "claimed" }) },
  // ── notes, drafts, sends ───────────────────────────────────────────────────────────────────
  { id: "contact_notes~contacts", table: "contact_notes", foreign: "contactId",
    row: (p, o) => ({ account_id: o.accountId, contact_id: p("contactId"), body: "iso" }) },
  { id: "thread_notes~threads", table: "thread_notes", foreign: "threadId",
    row: (p, o) => ({ account_id: o.accountId, thread_id: p("threadId"), body: "iso" }) },
  { id: "drafts~mailboxes", table: "drafts", foreign: "mailboxId",
    row: (p, o) => ({ account_id: o.accountId, mailbox_id: p("mailboxId") }) },
  { id: "drafts~threads", table: "drafts", foreign: "threadId",
    row: (p, o) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), thread_id: p("threadId") }) },
  { id: "drafts~messages", table: "drafts", foreign: "messageId",
    row: (p, o) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"),
      in_reply_to_message_id: p("messageId") }) },
  // The forward key: the message a draft forwards, keyed as the reply column above is.
  { id: "drafts~messages(forward)", table: "drafts", foreign: "messageId",
    row: (p, o) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"),
      forward_of_message_id: p("messageId") }) },
  { id: "outbound_sends~drafts", table: "outbound_sends", foreign: "draftId",
    row: (p, o, n) => ({ account_id: o.accountId, draft_id: p("draftId"),
      idempotency_key: `iso-${n}-${randomUUID()}`, minted_message_id: `<iso-${n}@iso.test>` }) },
  { id: "outbound_send_fingerprints~sends", table: "outbound_send_fingerprints", foreign: "sendId",
    row: (p, o) => ({ account_id: o.accountId, send_id: p("sendId"), mailbox_id: p("mailboxId"),
      fingerprint: hex64() }) },
  // A delivered send's owed Sent copy (mail 0170), keyed to its send as the claim above is.
  { id: "outbound_sent_copies~sends", table: "outbound_sent_copies", foreign: "sendId",
    row: (p, o) => ({ account_id: o.accountId, send_id: p("sendId"), mailbox_id: p("mailboxId"), raw_b64: "aXNv" }) },
  { id: "workflow_runs~workflows", table: "workflow_runs", foreign: "workflowId",
    row: (p, o) => ({ account_id: o.accountId, workflow_id: p("workflowId") }) },
  // ── the away responder and the organizer, which carried parent ids with NO key at all ──────
  { id: "away_replies~mailboxes", table: "away_replies", foreign: "mailboxId",
    row: (p, o) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), message_id: p("messageId"),
      sender: "iso@iso.test", outcome: "pending" }) },
  { id: "away_replies~messages", table: "away_replies", foreign: "messageId",
    row: (p, o) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), message_id: p("messageId"),
      sender: "iso@iso.test", outcome: "pending" }) },
  { id: "away_responder_sent~messages", table: "away_responder_sent", foreign: "messageId",
    row: (p, o) => ({ account_id: o.accountId, message_id: p("messageId"), sender: "iso@iso.test",
      responder_updated_at: new Date(0).toISOString() }) },
  { id: "organizer_requests~mailboxes", table: "organizer_requests", foreign: "mailboxId",
    row: (p, o) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), kind: "rule.create",
      payload: "{}", decided_at: new Date(0).toISOString() }) },
  { id: "mailbox_profile_mirror~mailboxes", table: "mailbox_profile_mirror", foreign: "mailboxId",
    row: (p, o) => ({ account_id: o.accountId, mailbox_id: p("mailboxId"), doc: "{}" }) },
  // ── the identity half ──────────────────────────────────────────────────────────────────────
  { id: "devices~users", table: "devices", foreign: "userId",
    row: (p, o) => ({ account_id: o.accountId, user_id: p("userId"), kind: "web" }) },
  { id: "sessions~users", table: "sessions", foreign: "userId",
    row: (p, o) => ({ account_id: o.accountId, user_id: p("userId"), family_id: randomUUID(),
      access_expires_at: future(), refresh_expires_at: future() }) },
  { id: "sessions~devices", table: "sessions", foreign: "deviceId",
    row: (p, o) => ({ account_id: o.accountId, user_id: p("userId"), device_id: p("deviceId"),
      family_id: randomUUID(), access_expires_at: future(), refresh_expires_at: future() }) },
  { id: "refresh_tokens~users", table: "refresh_tokens", foreign: "userId",
    row: (p, o) => ({ account_id: o.accountId, user_id: p("userId"), session_id: p("sessionId"),
      family_id: randomUUID(), token_hash: hex64(), expires_at: future() }) },
  { id: "refresh_tokens~sessions", table: "refresh_tokens", foreign: "sessionId",
    row: (p, o) => ({ account_id: o.accountId, user_id: p("userId"), session_id: p("sessionId"),
      family_id: randomUUID(), token_hash: hex64(), expires_at: future() }) },
  { id: "push_subscriptions~devices", table: "push_subscriptions", foreign: "deviceId",
    row: (p, o) => ({ account_id: o.accountId, device_id: p("deviceId"), transport: "web" }) },
  { id: "auth_events~users", table: "auth_events", foreign: "userId",
    row: (p, o) => ({ account_id: o.accountId, user_id: p("userId"), event: "iso" }) },
  // ── the ONE key scoped by MAILBOX: a folder op may not name another mailbox's folder ───────
  { id: "folder_ops~folders~mailboxes (same account, other mailbox)", table: "folder_ops",
    foreign: "mailboxTwoId", within: "mailboxId",
    row: (p, o) => ({ account_id: o.accountId, mailbox_id: p("mailboxTwoId"),
      folder_id: o.folderTwoId, op: "create" }) },
];

describe.skipIf(!HAVE_PG)("account isolation is a database constraint (real Postgres)", () => {
  let client: ReturnType<typeof postgres>;
  let A: Fixture;
  let B: Fixture;
  let n = 0;

  async function fixture(tag: string): Promise<Fixture> {
    const f: Fixture = {
      accountId: randomUUID(), mailboxId: randomUUID(), folderId: randomUUID(),
      mailboxTwoId: randomUUID(), folderTwoId: randomUUID(),
      threadId: randomUUID(), messageId: randomUUID(), contactId: randomUUID(),
      tagId: randomUUID(), draftId: randomUUID(), sendId: randomUUID(),
      decisionId: randomUUID(), ruleId: randomUUID(), workflowId: randomUUID(),
      userId: randomUUID(), deviceId: randomUUID(), sessionId: randomUUID(),
    };
    const q = client;
    await q`insert into accounts (id, name) values (${f.accountId}, ${`iso-${tag}`})`;
    await q`insert into users (id, account_id, email) values (${f.userId}, ${f.accountId}, ${`${tag}-${f.userId}@iso.test`})`;
    await q`insert into devices (id, account_id, user_id, kind) values (${f.deviceId}, ${f.accountId}, ${f.userId}, 'web')`;
    await q`insert into sessions (id, account_id, user_id, family_id, access_expires_at, refresh_expires_at)
            values (${f.sessionId}, ${f.accountId}, ${f.userId}, ${randomUUID()}, ${future()}, ${future()})`;
    await q`insert into mailboxes (id, account_id, provider, address)
            values (${f.mailboxId}, ${f.accountId}, 'imap', ${`${tag}-${f.mailboxId}@iso.test`})`;
    await q`insert into mailbox_folders (id, mailbox_id, folder) values (${f.folderId}, ${f.mailboxId}, 'INBOX')`;
    await q`insert into mailboxes (id, account_id, provider, address)
            values (${f.mailboxTwoId}, ${f.accountId}, 'imap', ${`${tag}-2-${f.mailboxTwoId}@iso.test`})`;
    await q`insert into mailbox_folders (id, mailbox_id, folder) values (${f.folderTwoId}, ${f.mailboxTwoId}, 'INBOX')`;
    await q`insert into threads (id, account_id) values (${f.threadId}, ${f.accountId})`;
    await q`insert into messages (id, account_id, mailbox_id, body_hash, dedup_key)
            values (${f.messageId}, ${f.accountId}, ${f.mailboxId}, 'h', ${`iso-root-${f.messageId}`})`;
    await q`insert into contacts (id, account_id, address) values (${f.contactId}, ${f.accountId}, ${`${tag}-${f.contactId}@iso.test`})`;
    await q`insert into tags (id, account_id, name) values (${f.tagId}, ${f.accountId}, ${`iso-${f.tagId}`})`;
    await q`insert into drafts (id, account_id, mailbox_id) values (${f.draftId}, ${f.accountId}, ${f.mailboxId})`;
    await q`insert into outbound_sends (id, account_id, idempotency_key, minted_message_id)
            values (${f.sendId}, ${f.accountId}, ${`iso-${f.sendId}`}, ${`<${f.sendId}@iso.test>`})`;
    await q`insert into rules (id, account_id, kind, match, destination)
            values (${f.ruleId}, ${f.accountId}, 'sender', 'iso@iso.test', 'inbox')`;
    await q`insert into routing_decisions (id, account_id, message_id, input_provenance, destination, status)
            values (${f.decisionId}, ${f.accountId}, ${f.messageId}, 'iso', 'inbox', 'applied')`;
    await q`insert into workflows (id, account_id, name) values (${f.workflowId}, ${f.accountId}, 'iso')`;
    return f;
  }

  beforeAll(async () => {
    client = postgres(DB_URL, { max: 1, onnotice: () => {} });
    A = await fixture("a");
    B = await fixture("b");
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    for (const f of [A, B]) {
      if (!f) continue;
      await client`delete from accounts where id = ${f.accountId}`.catch(() => undefined);
    }
    await client.end({ timeout: 5 });
  });

  /** Thrown to end a plant's transaction; every plant leaves the fixture exactly as it found it. */
  const ROLLBACK = Symbol("rollback");

  /**
   * Insert one child row and answer with the driver's SQLSTATE, or null when the store took it.
   * `foreign` names the one reference resolved against A; every other reference is B's own.
   *
   * The insert runs inside a transaction this function always rolls back. Six cases otherwise
   * read 23505 off an EARLIER case's surviving control row — a unique violation dressed as an
   * isolation reading — and a case that measures the fixture measures nothing.
   */
  async function plant(c: Case, foreign: boolean): Promise<string | null> {
    const pick: Pick = (k) =>
      (foreign && k === c.foreign ? (c.within ? B[c.within] : A[k]) : B[k]);
    const row = c.row(pick, B, ++n);
    const cols = Object.keys(row);
    const text = `insert into "${c.table}" (${cols.map((k) => `"${k}"`).join(", ")}) ` +
      `values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`;
    try {
      await client.begin(async (tx) => {
        await tx.unsafe(text, cols.map((k) => row[k] as never));
        throw ROLLBACK;
      });
      return null;
    } catch (err) {
      if (err === ROLLBACK) return null;
      return String((err as { code?: unknown }).code ?? "unknown");
    }
  }

  it("covers every pair the isolation audit derived, and says so by count", () => {
    // The audit's 39 LESS `outbound_send_fingerprints~mailboxes`, plus the one case only the
    // mailbox-scoped key refuses, plus the forward key, plus the owed Sent copy (mail 0170). A case
    // removed silently is a pair nobody measures, so the number is asserted rather than counted by eye.
    expect(CASES.length).toBe(41);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(41);
  });

  it("REFUSES a webauthn challenge naming a user that does not exist", async () => {
    // The one child of a scoped parent that carried no key at all: the parent was not even
    // guaranteed to be there. Nullable still, because a registration ceremony has no user yet.
    const text = `insert into "webauthn_challenges" ` +
      `("user_id", "challenge", "type", "rp_id", "origin", "expires_at") values ($1,$2,$3,$4,$5,$6)`;
    const args = [randomUUID(), randomUUID(), "registration", "iso.test", "https://iso.test", future()];
    let code: string | null = null;
    try {
      await client.begin(async (tx) => { await tx.unsafe(text, args as never[]); throw ROLLBACK; });
    } catch (err) { if (err !== ROLLBACK) code = String((err as { code?: unknown }).code ?? "unknown"); }
    expect(code).toBe("23503");
  });

  it("still admits the two states auth_events keeps nullable", async () => {
    // An event can precede an account, and an attempt can name an address no user has. The key is
    // MATCH SIMPLE, so it bites only when both columns are present — the one state they can differ.
    const one = async (userId: string | null, accountId: string | null) => {
      let code: string | null = null;
      try {
        await client.begin(async (tx) => {
          await tx.unsafe(`insert into "auth_events" ("user_id", "account_id", "event") values ($1,$2,$3)`,
            [userId, accountId, "iso"] as never[]);
          throw ROLLBACK;
        });
      } catch (err) { if (err !== ROLLBACK) code = String((err as { code?: unknown }).code ?? "unknown"); }
      return code;
    };
    expect(await one(null, null)).toBeNull();
    expect(await one(null, B.accountId)).toBeNull();
    expect(await one(B.userId, null)).toBeNull();
  });

  it.each(CASES.map((c) => [c.id, c] as const))(
    "REFUSES a cross-account row: %s",
    async (_id, c) => {
      // The positive control first: without it a table that refuses every insert reads as isolated.
      expect(await plant(c, false)).toBeNull();
      expect(await plant(c, true)).toBe("23503");
    },
    30_000,
  );
});
