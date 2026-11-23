import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRoutes, type ApiDeps } from "@trafficflow/api";
import { UNMETERED_STORAGE_CAP, commitChange, planChange, type Change } from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { accounts, folderState, mailboxes, messages, rules } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { MessageService, RulesService, ScreenerService, dbFor } from "@trafficflow/services";
import type { Folder } from "@ohmail/wire";

const PG_UP = await realPgAvailable();
const GATE = "ohmail/Screener";
const SCREENED = "ohmail/Screened";
const sender = "writer@example.test";
let owned: OwnedDb;

async function world() {
  const accountId = randomUUID();
  await owned.db.insert(accounts).values({ id: accountId, name: "Screener filing test" });
  const [mailbox] = await owned.db.insert(mailboxes).values({
    accountId, provider: "imap", address: "reader@example.test", organizerRole: "organizer", status: "connected",
  }).returning({ id: mailboxes.id });
  const db = dbFor(owned.db, accountId);
  const mailboxId = mailbox!.id;
  let uid = 0;
  let now = new Date("2026-10-22T10:00:00.000Z");

  const press = (pattern: string, method: string, id: string, body: unknown, key = randomUUID()) => {
    now = new Date(now.getTime() + 1000);
    const route = apiRoutes.find((r) => r.pattern === pattern && r.method === method)!;
    const request = new Request("http://localhost" + pattern.replace(":id", id), {
      method, headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    const deps = {
      db, session: { accountId, userId: null, sessionId: null },
      now: () => now, requestId: randomUUID(),
      services: { message: new MessageService(), rules: new RulesService(), screener: new ScreenerService({}) },
    } as ApiDeps;
    return route.handler(request, deps, { id });
  };

  const placed = async (id: string): Promise<string> => {
    const [row] = await db.select({ folder: folderState.desiredFolder }).from(folderState).where(and(
      eq(folderState.messageId, id), eq(folderState.accountId, accountId),
    ));
    return row!.folder;
  };

  const ingest = async (address = sender) => {
    const change: Change = {
      type: "create", locator: { folder: "INBOX", ref: `1:${++uid}` }, internalDate: now,
      raw: Buffer.from([
        `Message-ID: <${randomUUID()}@example.test>`,
        `From: ${address}`,
        "To: reader@example.test",
        "Subject: A letter",
        "",
        "A note from the sender.",
      ].join("\r\n")),
    };
    const scope = { accountId, mailboxId };
    const plan = await planChange(change, { ...scope, repo: makeDrizzleRepo(db) });
    const written = await db.transaction((tx) => commitChange(plan, {
      ...scope, repo: makeDrizzleRepo(tx as never), storageCap: UNMETERED_STORAGE_CAP,
    }));
    return { id: written.messageId, folder: await placed(written.messageId) };
  };

  return { db, accountId, mailboxId, press, placed, ingest };
}

describe.skipIf(!PG_UP)("decisions route the next arrival before any organizer pass", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => { await owned?.close(); });

  it.each<Folder>(["INBOX", "ohmail/News", "ohmail/Receipts"])(
    "files a release and later restores the previous routing for %s",
    async (destination) => {
      const w = await world();
      const first = await w.ingest();
      expect(first.folder).toBe(GATE);
      const screened = await w.press("/screener/:id", "POST", first.id, { decision: "no" });
      expect(screened.status).toBe(200);
      const { createdRuleId } = await screened.json();
      const next = await w.ingest();
      expect(next.folder).toBe(SCREENED);

      const messageIds = [first.id, next.id];
      const released = await w.press("/rules/:id", "PATCH", createdRuleId, {
        destination, release: { messageIds, from: SCREENED, to: destination },
      });
      expect(released.status).toBe(200);
      expect(await Promise.all(messageIds.map(w.placed))).toEqual([destination, destination]);
      const whileReleased = await w.ingest();
      expect(whileReleased.folder).toBe(destination);
      expect((await w.ingest("another@example.test")).folder).toBe(GATE);

      const undone = await w.press("/rules/:id", "PATCH", createdRuleId, {
        destination: SCREENED, applyRetro: false, keepProvenance: true, restoreProvenance: "promoted",
        release: { messageIds, from: destination, to: SCREENED },
      });
      expect(undone.status).toBe(200);
      expect(await Promise.all(messageIds.map(w.placed))).toEqual([SCREENED, SCREENED]);
      expect(await w.placed(whileReleased.id)).toBe(destination);
      expect((await w.ingest()).folder).toBe(SCREENED);
    },
  );

  it.each([
    ["yes", "INBOX"], ["no", SCREENED], ["yes", "ohmail/News"], ["yes", "ohmail/Receipts"],
  ])("uses the initial %s decision for the very next arrival in %s", async (decision, dest) => {
    const w = await world();
    const first = await w.ingest();
    expect(first.folder).toBe(GATE);
    const result = await w.press("/screener/:id", "POST", first.id, { decision, dest });
    expect(result.status).toBe(200);
    expect((await w.ingest()).folder).toBe(dest);
    expect((await w.ingest("another@example.test")).folder).toBe(GATE);
  });

  it("moves only the first 500 named letters and arms the rule's backlog", async () => {
    const w = await world();
    const first = await w.ingest();
    const screened = await w.press("/screener/:id", "POST", first.id, { decision: "no" });
    expect(screened.status).toBe(200);
    const { createdRuleId } = await screened.json();
    const messageIds = [first.id, ...Array.from({ length: 500 }, () => randomUUID())];
    const extra = messageIds.slice(1);
    await w.db.insert(messages).values(extra.map((id) => ({
      id, accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: id, dedupKey: id, fromAddress: sender,
    })));
    await w.db.insert(folderState).values(extra.map((messageId) => ({
      messageId, accountId: w.accountId, desiredFolder: SCREENED, observedFolder: SCREENED, lastSetBy: "us",
    })));

    const released = await w.press("/rules/:id", "PATCH", createdRuleId, {
      destination: "INBOX", release: { messageIds, from: SCREENED, to: "INBOX" },
    });
    expect(released.status).toBe(200);
    const [filed] = await w.db.select({ total: count() }).from(folderState).where(and(
      eq(folderState.accountId, w.accountId), eq(folderState.desiredFolder, "INBOX"),
    ));
    expect(filed?.total).toBe(500);
    expect(await w.placed(messageIds[500]!)).toBe(SCREENED);
    expect(await released.json()).toMatchObject({ retro: { requestedAt: expect.any(String), doneAt: null } });
    expect((await w.ingest()).folder).toBe("INBOX");
  }, 60_000);

  it("rolls back the entire release if a named letter has already moved", async () => {
    const w = await world();
    const first = await w.ingest();
    const screened = await w.press("/screener/:id", "POST", first.id, { decision: "no" });
    const { createdRuleId } = await screened.json();
    const later = await w.ingest();
    const [held, moved] = [first.id, later.id].sort();
    await w.db.update(folderState).set({ desiredFolder: "ohmail/Receipts" }).where(and(
      eq(folderState.accountId, w.accountId), eq(folderState.messageId, moved!),
    ));

    await expect(w.press("/rules/:id", "PATCH", createdRuleId, {
      destination: "INBOX", release: { messageIds: [first.id, later.id], from: SCREENED, to: "INBOX" },
    })).rejects.toMatchObject({ code: "stale_press" });
    expect(await w.placed(held!)).toBe(SCREENED);
    expect(await w.placed(moved!)).toBe("ohmail/Receipts");
    expect((await w.ingest()).folder).toBe(SCREENED);
  });

  it("refuses to include another account's letter even with the same sender and folder", async () => {
    const w = await world();
    const other = await world();
    const own = await w.ingest();
    const foreign = await other.ingest();
    const ownDecision = await w.press("/screener/:id", "POST", own.id, { decision: "no" });
    const otherDecision = await other.press("/screener/:id", "POST", foreign.id, { decision: "no" });
    expect(otherDecision.status).toBe(200);
    const { createdRuleId } = await ownDecision.json();

    await expect(w.press("/rules/:id", "PATCH", createdRuleId, {
      destination: "INBOX", release: { messageIds: [own.id, foreign.id], from: SCREENED, to: "INBOX" },
    })).rejects.toMatchObject({ code: "not_found" });
    expect(await w.placed(own.id)).toBe(SCREENED);
    expect(await other.placed(foreign.id)).toBe(SCREENED);
    expect((await w.ingest()).folder).toBe(SCREENED);
  });

  it("leaves a domain rule standing on release and Undo", async () => {
    const w = await world();
    const first = await w.ingest();
    const screened = await w.press("/screener/:id", "POST", first.id, { decision: "no", scope: "domain" });
    expect(screened.status).toBe(200);
    const { createdRuleId } = await screened.json();
    const released = await w.press("/rules", "POST", "", {
      kind: "sender", match: sender, destination: "INBOX",
      release: { messageIds: [first.id], from: SCREENED, to: "INBOX" },
    });
    expect(released.status).toBe(201);
    expect(await w.placed(first.id)).toBe("INBOX");
    const { id } = await released.json();
    expect((await w.ingest()).folder).toBe("INBOX");
    expect((await w.ingest("another@example.test")).folder).toBe(SCREENED);

    const undoKey = randomUUID();
    const undo = () => w.press("/rules/:id", "DELETE", id, {
      release: { messageIds: [first.id], from: "INBOX", to: SCREENED },
    }, undoKey);
    const [undone, replayed] = await Promise.all([undo(), undo()]);
    expect(undone.status).toBe(204);
    expect(replayed.status).toBe(204);
    expect(replayed.headers.get("x-sync-seq")).toBe(undone.headers.get("x-sync-seq"));
    const remaining = await w.db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, w.accountId));
    expect(remaining).toEqual([{ id: createdRuleId }]);
    expect(await w.placed(first.id)).toBe(SCREENED);
    expect((await w.ingest()).folder).toBe(SCREENED);
  });
});
