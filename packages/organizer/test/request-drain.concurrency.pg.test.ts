import { accountOfMessage } from "@trafficflow/db";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  mailboxes, messages, folderState, rules, contacts, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  formatRequest, acksIn, deriveRequestKey,
  type RequestOrganizerIo, type RawMetaMessage, type MetaRecordsList,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests } from "../src/request-drain.js";
import { listedOf } from "./_meta-list.js";

/** The drain refuses a runtime with no install, so every fixture states one. */
const TEST_INSTALL = "test-install";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  TWO DRAINS, ONE RECORD, ONE RULE — on REAL Postgres (mail 0090)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The failure this guards: two organizer cycles read `ohmail/_meta` and find the SAME request
 * record, and both apply it — two `promoted` rules and two contact rows for one press. Nothing in
 * the codebase stops the overlap; a poll timer re-entering while a slow cycle finishes, or two
 * worker processes during a leader handover, is enough.
 *
 * What stands between that and a double-apply is `claimIdempotencyKey` at `meta-request:<id>`,
 * claimed INSIDE the same transaction as the effect. **PGlite green means nothing here** — this
 * repo's own operational trap, and the reason this file exists beside the unit suite: the guard is
 * a unique-index conflict resolved under two genuinely concurrent connections, and only real
 * Postgres arbitrates it. `organizer-requests.concurrency.pg.test.ts` is the precedent in shape.
 *
 * ── AND THE CONTENT COMPARISON IS RACED TOO ─────────────────────────────────────────────────
 *
 * The second test is the same race with DIFFERENT content behind one id — the substitution attack.
 * Exactly one of the two may apply, and whichever loses must be REFUSED rather than silently
 * skipped, or an impostor's record could spend the genuine one's key.
 */

const AVAILABLE = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 5 });
const sqlB = postgres(PG_TEST_URL, { max: 5 });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg") as unknown as Tx;
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg") as unknown as Tx;

/**
 * A FRESH ACCOUNT PER TEST. Every assertion below counts rows BY ACCOUNT — "exactly one rule" IS
 * the property — so a shared account lets the first test's rule be counted by the second. That is
 * not a cosmetic flake: it turns a passing race red for the wrong reason, and the explaining-away
 * that follows is exactly how a real double-apply would get waved through.
 */
function freshAccount(): string { return randomUUID(); }
const NOW = new Date("2026-09-03T12:00:00.000Z");

/**
 * Derived, not stored: both racing cycles hold the same credential, so both arrive at the same
 * key without either being told it. That is the property the whole channel rests on.
 */
const ADDRESS = "racer@mailbox.example";
const KEY = deriveRequestKey({ auth: { user: ADDRESS, pass: "shared-password" }, address: ADDRESS })!;

/**
 * ONE shared folder, handed to two organizer objects on two different CONNECTIONS — the two
 * cycles see the same records, exactly as two processes polling one mailbox would.
 */
function sharedFolder(): {
  store: Map<number, string>; seed: (raw: string) => void; io: () => RequestOrganizerIo;
} {
  const store = new Map<number, string>();
  let nextUid = 1;
  // SEEDED THROUGH THE SAME COUNTER the appends use. Writing `store.set(1, …)` directly left
  // `nextUid` at 1, so the organizer's first ack OVERWROTE the record it was answering — the
  // record then vanished, the ack went with it on the expunge, and the test failed claiming no
  // refusal had been acknowledged when one had.
  const seed = (raw: string): void => { store.set(nextUid++, raw); };
  const io = (): RequestOrganizerIo => ({
    async listMetaRecords(): Promise<MetaRecordsList> {
      return listedOf([...store.entries()].map(([ref, raw]) => ({ ref, raw })));
    },
    async ack(raw: string): Promise<void> { store.set(nextUid++, raw); },
    async remove(refs: readonly unknown[]): Promise<void> {
      for (const r of refs) if (typeof r === "number") store.delete(r);
    },
  });
  return { store, seed, io };
}

function adapterFor(io: RequestOrganizerIo): MailboxAdapter {
  return { requestOrganizerIo: () => io } as unknown as MailboxAdapter;
}

async function seedMailbox(ACCT: string): Promise<string> {
  const [mb] = await dbA.insert(mailboxes).values({
    accountId: ACCT, provider: "imap", address: `${randomUUID()}@x.example`,
  }).returning({ id: mailboxes.id });
  return mb!.id;
}

async function seedHeld(ACCT: string, mailboxId: string, from: string): Promise<void> {
  const [m] = await dbA.insert(messages).values({
    accountId: ACCT, mailboxId, bodyHash: randomUUID(), dedupKey: `mid:${randomUUID()}`,
    subject: "s", fromAddress: from, unread: true,
  }).returning({ id: messages.id });
  await dbA.insert(folderState).values({
    messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
}

const noopLog = (): void => undefined;

function record(o: { requestId: string; mailboxId: string; key: string; address: string }): string {
  return formatRequest({
    requestId: o.requestId, kind: "screener.decide", mailboxId: o.mailboxId,
    installId: "reader-install", organizerKind: "local", decidedAt: NOW,
    payload: { scope: "sender", address: o.address, appliedFolder: "INBOX", decision: "yes" },
    key: o.key,
  });
}

describe.skipIf(!AVAILABLE)("the request drain under real-Postgres concurrency", () => {
  beforeAll(async () => { await runMigrations(PG_TEST_URL); });
  afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

  it("two cycles draining the SAME record produce exactly one rule", async () => {
    const ACCT = freshAccount();
    const mailboxId = await seedMailbox(ACCT);
    await seedHeld(ACCT, mailboxId, "person@example.com");
    const key = KEY;
    const folder = sharedFolder();
    const requestId = randomUUID();
    folder.seed(record({ requestId, mailboxId, key, address: "person@example.com" }));

    const [a, b] = await Promise.all([
      applyMetaRequests(dbA, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: adapterFor(folder.io()), requestKey: KEY }, NOW, noopLog),
      applyMetaRequests(dbB, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: adapterFor(folder.io()), requestKey: KEY }, NOW, noopLog),
    ]);

    // Both cycles HANDLED it — one applied it, the other found the key spent for the same content
    // and treated it as the replay it is. Neither may report a refusal.
    expect(a.refused + b.refused).toBe(0);
    expect(a.applied + b.applied).toBeGreaterThanOrEqual(1);

    // The property that actually matters.
    const madeRules = await dbA.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(madeRules).toHaveLength(1);
    const madeContacts = await dbA.select().from(contacts).where(eq(contacts.accountId, ACCT));
    expect(madeContacts).toHaveLength(1);
  });

  /**
   * THE SUBSTITUTION ATTACK, RACED. One id, two different payloads, two concurrent drains.
   * Exactly one may apply; the other must be REFUSED with `conflict` rather than skipped, because
   * a skip would let an impostor's record consume the genuine record's key.
   */
  it("two cycles racing the same id with DIFFERENT content: one applies, one is refused conflict", async () => {
    const ACCT = freshAccount();
    const mailboxId = await seedMailbox(ACCT);
    await seedHeld(ACCT, mailboxId, "genuine@example.com");
    await seedHeld(ACCT, mailboxId, "impostor@example.com");
    const key = KEY;
    const sharedId = randomUUID();

    const folderA = sharedFolder();
    folderA.seed(record({ requestId: sharedId, mailboxId, key, address: "genuine@example.com" }));
    const folderB = sharedFolder();
    folderB.seed(record({ requestId: sharedId, mailboxId, key, address: "impostor@example.com" }));

    const [a, b] = await Promise.all([
      applyMetaRequests(dbA, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: adapterFor(folderA.io()), requestKey: KEY }, NOW, noopLog),
      applyMetaRequests(dbB, { mailboxId, accountId: ACCT, installId: TEST_INSTALL, adapter: adapterFor(folderB.io()), requestKey: KEY }, NOW, noopLog),
    ]);

    // One of the two won the key; the other saw a spent key standing for different content.
    expect(a.applied + b.applied).toBe(1);
    expect(a.refused + b.refused).toBe(1);

    const madeRules = await dbA.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(madeRules).toHaveLength(1);
    // Whichever won, exactly ONE address was acted on — never both, never neither.
    expect(["genuine@example.com", "impostor@example.com"]).toContain(madeRules[0]!.match);

    // And the loser said WHY, on an ack the reader can read.
    const acks = [
      ...acksIn([...folderA.store.entries()].map(([ref, raw]) => ({ ref, raw })), key),
      ...acksIn([...folderB.store.entries()].map(([ref, raw]) => ({ ref, raw })), key),
    ];
    expect(acks.some((x) => x.outcome === "refused" && x.reason === "conflict")).toBe(true);
  });
});
