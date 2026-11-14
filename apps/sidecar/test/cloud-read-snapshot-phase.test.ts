import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { folderState, mailboxes, messages, messageTags, tags } from "@trafficflow/db";
import type { ServiceContext, SnapshotResponse } from "@trafficflow/services/mail";
import { matchReadRoute } from "../src/cloud-read.js";

/**
 * THE CLOUD DOOR'S SNAPSHOT READS THE PHASE THE WINDOW ASKS FOR.
 *
 * A windowed client re-hydrates tagged mail its retention once evicted with `?phase=tail`, the
 * labelled tail alone. The local door reads the phase; this door read only `cursor` and `limit`,
 * so the ask ran the ordinary walk and answered the newest mail the client already holds.
 */

const ACCOUNT = randomUUID();
const NOW = new Date("2026-09-28T09:00:00.000Z");
const DAY = 86_400_000;

async function corpus(): Promise<{ ctx: ServiceContext; tagged: string; recent: string[] }> {
  const db = await makeTestDb();
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: "me@ohmail.test" }).returning();
  const add = async (i: number, ageDays: number): Promise<string> => {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: ACCOUNT, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: `m ${i}`, fromAddress: "sender@example.test", date: new Date(NOW.getTime() - ageDays * DAY),
      nativeLocator: { folder: "INBOX", ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({ messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us" });
    return m!.id;
  };
  const recent = [await add(1, 1), await add(2, 2)];
  const tagged = await add(3, 400);
  const [t] = await db.insert(tags).values({ accountId: ACCOUNT, name: "Invoices", hue: "moss" }).returning();
  await db.insert(messageTags).values({ accountId: ACCOUNT, messageId: tagged, tagId: t!.id });
  return { ctx: { db, accountId: ACCOUNT, userId: null, now: () => NOW, requestId: "cloud-snapshot-phase" }, tagged, recent };
}

async function snapshot(ctx: ServiceContext, query: string): Promise<SnapshotResponse> {
  const url = `http://sidecar/sync/snapshot${query}`;
  const hit = matchReadRoute("GET", new URL(url).pathname);
  if (!hit) throw new Error("no /sync/snapshot route in READ_ROUTES");
  const res = await hit.route.handler(new Request(url), ctx, hit.params);
  expect(res.status).toBe(200);
  return (await res.json()) as SnapshotResponse;
}

const messageIds = (p: SnapshotResponse): string[] => p.changes.filter((c) => c.type === "message").map((c) => c.id);

describe("the Cloud door's /sync/snapshot", () => {
  it("?phase=tail answers the labelled tail alone", async () => {
    const { ctx, tagged } = await corpus();
    expect(messageIds(await snapshot(ctx, "?phase=tail"))).toEqual([tagged]);
  });

  it("without a phase it is the ordinary walk, newest first", async () => {
    const { ctx, tagged, recent } = await corpus();
    expect(messageIds(await snapshot(ctx, ""))).toEqual([...recent, tagged]);
  });

  it("a phase this build has never heard of is the ordinary walk too", async () => {
    const { ctx, tagged, recent } = await corpus();
    expect(messageIds(await snapshot(ctx, "?phase=later"))).toEqual([...recent, tagged]);
  });
});
