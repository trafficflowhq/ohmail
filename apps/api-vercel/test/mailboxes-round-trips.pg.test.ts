import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  accounts, folderState, mailboxCredentials, mailboxFolders, mailboxes, messageFailures, messages, sessions, users,
} from "@trafficflow/db";
import { closePooledDbs, makePooledDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable, recordPgWire } from "@trafficflow/db/testing";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { resetHostState } from "../src/config.js";
import { resetServices } from "../src/deps.js";
import { handleApiRequest } from "../src/handler.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * THE POLLED MAILBOX LIST COSTS THE SAME WHATEVER THE NUMBER OF MAILBOXES: `GET /mailboxes` through
 * the deployed host over its pooled client, counted off the protocol bytes on the wire, at 1, 3 and
 * 10 mailboxes, each with a credential, two folders, a filing and a failure. It read four facts per
 * mailbox (3 + 4N statements); now the session, the list, the organizer's last pass and four
 * statements for all of the facts. Round trips equal statements, as on every hot route.
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();
const KEK = "ab".repeat(32);
/** Statements one poll may cost, at any number of mailboxes: a ceiling that may only fall. */
const STATEMENTS = 7;

function install(): void {
  for (const k of ["TF_SSE_POLL_MS", "TF_SSE", "TF_COOKIE_HOSTS", "VERCEL_ENV", "ENTITLEMENTS_URL",
    "BILLING_PLANE_URL", "BILLING_PLANE_SECRET", "TF_APP_URL"]) delete process.env[k];
  Object.assign(process.env, {
    DATABASE_URL_POOLED: PG_TEST_URL, [KEY_RING_V1]: KEK, TF_AUTH_ORIGINS: "https://ohmail.app",
    TF_RP_ID: "ohmail.app", TF_BUILD_VERSION: "test-sha",
  });
  resetHostState();
  resetServices();
}

/** Wait until the wire has been quiet for a moment: work a response leaves behind is its own. */
async function settled(): Promise<void> {
  let last = -1;
  for (;;) {
    const n = wire.read().flushes.length;
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe.skipIf(!PG_UP)("GET /mailboxes on the deployed host costs the same at any number of mailboxes", () => {
  let db: Db;
  let token = "";
  let accountId = "";
  const boxes: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    install();
    db = makePooledDb(PG_TEST_URL);
    const now = new Date();
    token = generateToken();
    const [acct] = await db.insert(accounts).values({ name: `mbrt-${randomUUID().slice(0, 8)}` }).returning();
    accountId = acct!.id;
    const [user] = await db.insert(users).values({
      accountId, email: `mbrt-${randomUUID()}@rt.example`, displayName: "MBRT", emailVerifiedAt: now,
    }).returning();
    await db.insert(sessions).values({
      accountId, userId: user!.id, familyId: randomUUID(), accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(now.getTime() + 3_600_000), refreshExpiresAt: new Date(now.getTime() + 7_200_000),
      lastTwofaAt: now,
    });
  }, 120_000);

  afterAll(async () => {
    if (accountId !== "") {
      await db.execute(sql`delete from folder_state where message_id in (select id from messages where account_id = ${accountId})`);
      await db.delete(messages).where(eq(messages.accountId, accountId));
      await db.delete(messageFailures).where(eq(messageFailures.accountId, accountId));
      if (boxes.length > 0) {
        await db.delete(mailboxFolders).where(inArray(mailboxFolders.mailboxId, boxes));
        await db.delete(mailboxCredentials).where(inArray(mailboxCredentials.mailboxId, boxes));
      }
      await db.delete(mailboxes).where(eq(mailboxes.accountId, accountId));
      await db.delete(sessions).where(eq(sessions.accountId, accountId));
      await db.delete(users).where(eq(users.accountId, accountId));
      await db.delete(accounts).where(eq(accounts.id, accountId));
    }
    await closePooledDbs();
    resetHostState();
    resetServices();
  }, 60_000);

  async function addMailbox(i: number): Promise<void> {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `mbrt-${i}-${randomUUID().slice(0, 6)}@rt.example`, lastSyncAt: new Date(),
    }).returning();
    boxes.push(mb!.id);
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, transport: "imap", secretEnc: "sealed", keyVersion: 1, meta: { host: "imap.example.test" },
    });
    await db.insert(mailboxFolders).values({ mailboxId: mb!.id, folder: "INBOX", highestmodseq: 1n, serverExists: 10 });
    await db.insert(mailboxFolders).values({ mailboxId: mb!.id, folder: "Archive" });
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `mbrt:${randomUUID()}`, subject: "s",
      fromAddress: "x@rt.example", date: new Date(), unread: true, hasAttachments: false,
      nativeLocator: { folder: "INBOX", ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({ messageId: m!.id, desiredFolder: "Archive", observedFolder: "INBOX", lastSetBy: "us" });
    await db.insert(messageFailures).values({
      accountId, mailboxId: mb!.id, folder: "INBOX", uidvalidity: 1n, uid: i + 1, code: "mime_unparseable",
    });
  }

  async function counted(): Promise<{ status: number; items: number; statements: number; roundTrips: number; shape: string }> {
    const req = (): Request => new Request("https://api.ohmail.app/mailboxes", { headers: { authorization: `Bearer ${token}` } });
    await (await handleApiRequest(req())).text();
    await settled();
    wire.start();
    const res = await handleApiRequest(req());
    const body = await res.text();
    await settled();
    const r = wire.read();
    const items = res.status === 200 ? (JSON.parse(body) as { items: unknown[] }).items.length : -1;
    return { status: res.status, items, statements: r.statements, roundTrips: r.roundTrips, shape: r.flushes.join(" | ") };
  }

  it(`at 1, 3 and 10 mailboxes: the same statements, at most ${STATEMENTS}, one round trip each`, async () => {
    const cost: number[] = [];
    let have = 0;
    for (const n of [1, 3, 10]) {
      while (have < n) await addMailbox(have++);
      const r = await counted();
      console.log(`mailboxes-round-trips N=${n}: status=${r.status} statements=${r.statements} round_trips=${r.roundTrips}`);
      expect(r.status, r.shape).toBe(200);
      expect(r.items).toBe(n);
      expect(r.roundTrips, r.shape).toBe(r.statements);
      cost.push(r.statements);
    }
    expect(cost, "statements at 1, 3 and 10 mailboxes").toEqual([cost[0], cost[0], cost[0]]);
    expect(cost[0]).toBeLessThanOrEqual(STATEMENTS);
  }, 120_000);
});
