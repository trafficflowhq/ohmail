import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, sql } from "drizzle-orm";
import {
  accounts, accountSettings, accountSyncState, changeLog, folderState, mailboxes, messageBodies, messages,
  recordChange, rules, sessions, users,
} from "@trafficflow/db";
import { closePooledDbs, makePooledDb } from "@trafficflow/db/cloud";
import { brandDialect } from "@trafficflow/db/dialect";
import { ensureSearchExtensions, runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable, recordPgWire } from "@trafficflow/db/testing";
import { upsertMessageSearch } from "@trafficflow/core/mail";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { resetHostState } from "../src/config.js";
import { resetServices } from "../src/deps.js";
import { handleApiRequest } from "../src/handler.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * A HOT ROUTE PAYS ONE ROUND TRIP TO THE POOLER PER STATEMENT: the list, a body, the search page,
 * the rules, `/health` and an unchanged `/sync` poll, through the deployed host over its pooled
 * client, counted off the protocol bytes on the wire. Statements are pinned as ceilings; round
 * trips equal statements — a parameter's describe before its bind is the second trip this pins
 * out. The recorder is installed before the first connection; the host's own warm-up request
 * precedes each count (for `/sync`, the first empty tail, which takes the due sync stamp).
 */
const wire = recordPgWire();
const PG_UP = await realPgAvailable();
const KEK = "ab".repeat(32);

/** The statements each route issues today, begin and commit included: a ceiling, not a target. */
const STATEMENTS = { list: 9, body: 3, bodies: 6, search: 14, rules: 3, health: 1, syncHorizon: 2 } as const;
/**
 * The waits a search page costs on the host's own handle factory: the session, begin, the search
 * settings in the page's flush, commit. A probe the service keeps per handle is not one of them.
 */
const SEARCH_WAITS = 4;

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

describe.skipIf(!PG_UP)("the hot routes pay one round trip a statement (the deployed host, real Postgres)", () => {
  let db: Db;
  let token = "";
  let accountId = "";
  let horizon = "";
  const ids: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    install();
    db = makePooledDb(PG_TEST_URL);
    await ensureSearchExtensions(db as never);
    const now = new Date();
    token = generateToken();
    const [acct] = await db.insert(accounts).values({ name: `rt-${randomUUID().slice(0, 8)}` }).returning();
    accountId = acct!.id;
    const [user] = await db.insert(users).values({
      accountId, email: `rt-${randomUUID()}@rt.example`, displayName: "RT", emailVerifiedAt: now,
    }).returning();
    await db.insert(sessions).values({
      accountId, userId: user!.id, familyId: randomUUID(), accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(now.getTime() + 3_600_000), refreshExpiresAt: new Date(now.getTime() + 7_200_000),
      lastTwofaAt: now,
    });
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `rt-${randomUUID().slice(0, 8)}@rt.example` }).returning();
    for (let i = 0; i < 6; i++) {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `rt:${randomUUID()}`,
        subject: `heron sighting ${i}`, fromAddress: `watcher${i}@rt.example`,
        date: new Date(now.getTime() - i * 3_600_000), unread: true, hasAttachments: false,
        nativeLocator: { folder: "INBOX", ref: `1:${i}` },
      }).returning();
      ids.push(m!.id);
      await db.insert(messageBodies).values({ messageId: m!.id, text: `a heron by the lake, note ${i}` });
      await db.insert(folderState).values({ messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
      await upsertMessageSearch(db as never, m!.id, {
        accountId, subject: `heron sighting ${i}`, from: { name: null, address: `watcher${i}@rt.example` }, to: [], cc: [],
        attachmentNames: [], bodyText: `a heron by the lake, note ${i}`, source: "text",
      });
    }
    const [rule] = await db.insert(rules)
      .values({ accountId, kind: "sender", match: "watcher0@rt.example", destination: "ohmail/News" }).returning();
    await db.insert(accountSettings).values({ accountId, searchIndexBuiltAt: now })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: now } });
    // One change row, so `/sync` has a horizon to be polled at.
    await db.transaction((tx) => recordChange(tx as never, { accountId, entityType: "rule", entityId: rule!.id, op: "create" }));
    const boot = await handleApiRequest(new Request("https://api.ohmail.app/sync?since=0", {
      headers: { authorization: `Bearer ${token}` },
    }));
    horizon = (await boot.json() as { cursor: string }).cursor;
  }, 120_000);

  afterAll(async () => {
    if (accountId !== "") {
      await db.execute(sql`delete from message_search where account_id = ${accountId}`);
      await db.delete(folderState).where(inArray(folderState.messageId, ids));
      await db.delete(messageBodies).where(inArray(messageBodies.messageId, ids));
      await db.delete(messages).where(eq(messages.accountId, accountId));
      await db.delete(rules).where(eq(rules.accountId, accountId));
      await db.delete(mailboxes).where(eq(mailboxes.accountId, accountId));
      await db.delete(accountSettings).where(eq(accountSettings.accountId, accountId));
      await db.delete(changeLog).where(eq(changeLog.accountId, accountId));
      await db.delete(accountSyncState).where(eq(accountSyncState.accountId, accountId));
      await db.delete(sessions).where(eq(sessions.accountId, accountId));
      await db.delete(users).where(eq(users.accountId, accountId));
      await db.delete(accounts).where(eq(accounts.id, accountId));
    }
    await closePooledDbs();
    resetHostState();
    resetServices();
  }, 60_000);

  async function counted(path: string, bearer: boolean): Promise<{ status: number; statements: number; roundTrips: number; waits: number; shape: string }> {
    const req = (): Request => new Request(`https://api.ohmail.app${path}`, {
      headers: bearer ? { authorization: `Bearer ${token}` } : {},
    });
    await (await handleApiRequest(req())).text();
    await settled();
    wire.start();
    const res = await handleApiRequest(req());
    await res.text();
    await settled();
    const r = wire.read();
    // A flush the client waits after ends a round trip; statements written together share one.
    const waits = r.flushes.filter((k) => /[SHQ]/.test(k)).length;
    return { status: res.status, statements: r.statements, roundTrips: r.roundTrips, waits, shape: r.flushes.join(" | ") };
  }

  const routes: Array<[keyof typeof STATEMENTS, () => string, boolean]> = [
    ["list", () => "/messages?view=imbox", true],
    ["body", () => `/messages/${ids[0]}/body`, true],
    ["bodies", () => `/messages/bodies?ids=${ids.slice(0, 3).join(",")}`, true],
    ["search", () => "/search?q=heron&parts=page", true],
    ["rules", () => "/rules", true],
    ["health", () => "/health", false],
    // At the horizon, inside the stamp's window: the session read and the bounds read, no write.
    ["syncHorizon", () => `/sync?since=${encodeURIComponent(horizon)}`, true],
  ];

  for (const [name, path, bearer] of routes) {
    it(`${name}: every statement one round trip, at most ${STATEMENTS[name]} statements`, async () => {
      const r = await counted(path(), bearer);
      console.log(`round-trips ${name}: status=${r.status} statements=${r.statements} round_trips=${r.roundTrips} waits=${r.waits}`);
      expect(r.status, r.shape).toBeLessThan(400);
      expect(r.statements, r.shape).toBeGreaterThan(0);
      expect(r.statements, r.shape).toBeLessThanOrEqual(STATEMENTS[name]);
      expect(r.roundTrips, r.shape).toBe(r.statements);
      if (name === "search") expect(r.waits, r.shape).toBeLessThanOrEqual(SEARCH_WAITS);
    }, 60_000);
  }

  it("the reader sees a describe where one is paid: an untyped parameter on a door-less client is two", async () => {
    const bare = postgres(PG_TEST_URL, { max: 1, prepare: false, onnotice: () => {} });
    const plain = brandDialect(drizzle(bare), "pg");
    await plain.execute(sql`select 1`);
    wire.start();
    await plain.execute(sql`select ${"heron"}::text as t`);
    const r = wire.read();
    await bare.end({ timeout: 5 });
    expect(r.statements).toBe(1);
    expect(r.roundTrips).toBe(2);
  });
});
