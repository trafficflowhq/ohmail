import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountStorage, accounts, changeLog, mailboxes, messageBodies, messageInstances, messageSearch, messages,
} from "@trafficflow/db";
import { authThrottle } from "@trafficflow/db/cloud";
import {
  liveBody, liveBodyAdmitter, makeTestAuthDeps, throttleKeysFor, LIVE_BODY_MAX_BYTES, LIVE_BODY_PER_HOUR,
  ServiceError, type LiveBodyPlace, type LiveBodyRead, type ServiceContext,
} from "../src/index.js";

/**
 * LOAD IT NOW (cloud 0057's open half): a letter emptied for space, read from the mail server for one
 * view. The server's read is a port here, so the cases are about what the service decides and what it
 * leaves untouched; the IMAP door itself is driven against GreenMail in the API's own test.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const NOW = new Date("2026-11-07T12:00:00.000Z");

const LETTER = (messageId: string): string => [
  `Message-ID: <${messageId}>`, "From: Tom <tom@example.net>", "To: sam@example.com",
  "Subject: Kitchen plans, final version", "Date: Wed, 14 Jun 2017 16:20:00 +0000", "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "",
  "Hi Sam, here is the final version of the kitchen plans.", "--b1", "Content-Type: text/html; charset=utf-8", "",
  "<p>Hi Sam, here is the <b>final version</b> of the kitchen plans.</p>", "--b1--", "",
].join("\r\n");

interface World { db: Db; accountId: string; mailboxId: string; messageId: string; header: string }

async function world(withheld: string | null = "storage_cap", db?: Db): Promise<World> {
  const d = db ?? await makeTestDb();
  const accountId = randomUUID();
  await d.insert(accounts).values({ id: accountId, name: "Live" });
  const [mb] = await d.insert(mailboxes).values({
    accountId, provider: "imap", address: `sam-${accountId.slice(0, 8)}@example.com`,
  }).returning({ id: mailboxes.id });
  const header = `live-${randomUUID()}@example.com`;
  const [m] = await d.insert(messages).values({
    accountId, mailboxId: mb!.id, messageIdHeader: `<${header}>`, bodyHash: header, dedupKey: header,
    subject: "Kitchen plans, final version", fromAddress: "tom@example.net", snippet: "Hi Sam",
  }).returning({ id: messages.id });
  await d.insert(messageBodies).values({ messageId: m!.id, text: withheld ? "" : "kept text", html: null, withheldReason: withheld });
  await d.insert(messageInstances).values([
    { accountId, mailboxId: mb!.id, messageId: m!.id, folder: "Archive", uidvalidity: 7n, uid: 41, isPrimary: false },
    { accountId, mailboxId: mb!.id, messageId: m!.id, folder: "INBOX", uidvalidity: 7n, uid: 9, isPrimary: true },
  ]);
  return { db: d, accountId, mailboxId: mb!.id, messageId: m!.id, header };
}

const ctxOf = (w: Pick<World, "db" | "accountId">): ServiceContext =>
  ({ db: w.db, accountId: w.accountId, userId: null, now: () => NOW, requestId: "live" }) as unknown as ServiceContext;

/** A read port that records what it was asked and answers in turn. */
function reader(answer: (places: readonly LiveBodyPlace[]) => LiveBodyRead) {
  const asked: Array<{ mailboxId: string; places: LiveBodyPlace[]; maxBytes: number }> = [];
  return {
    asked,
    read: async (mailboxId: string, places: readonly LiveBodyPlace[], maxBytes: number) => {
      asked.push({ mailboxId, places: [...places], maxBytes });
      return answer(places);
    },
  };
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ServiceError) return { status: err.httpStatus, code: err.code };
    throw err;
  }
  throw new Error("expected a refusal");
}

/** Every row the load could have written, read whole. */
async function snapshot(w: World): Promise<string> {
  return JSON.stringify({
    body: await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, w.messageId)),
    message: await w.db.select({ updatedAt: messages.updatedAt, snippet: messages.snippet }).from(messages).where(eq(messages.id, w.messageId)),
    counter: await w.db.select().from(accountStorage),
    changes: (await w.db.select().from(changeLog)).length,
    words: (await w.db.select().from(messageSearch)).length,
  }, (_k, v) => (typeof v === "bigint" ? String(v) : v));
}

describe("Load it now", () => {
  it("serves an emptied letter's text from its primary place, through the storage gate, and writes nothing", async () => {
    const w = await world();
    const port = reader(() => ({ raw: Buffer.from(LETTER(w.header)) }));
    const before = await snapshot(w);
    const body = await liveBody(ctxOf(w), w.messageId, port);
    expect(body.text).toContain("Hi Sam, here is the final version of the kitchen plans.");
    expect(body.html).toContain("<b>final version</b>");
    expect(port.asked).toEqual([{
      mailboxId: w.mailboxId, maxBytes: LIVE_BODY_MAX_BYTES,
      places: [{ folder: "INBOX", uidvalidity: 7n, uid: 9 }, { folder: "Archive", uidvalidity: 7n, uid: 41 }],
    }]);
    expect(await snapshot(w), "the load wrote a row").toBe(before);
  });

  it("answers another account's letter exactly as an unknown id: 404, and the server is never asked", async () => {
    const db = await makeTestDb();
    const mine = await world("storage_cap", db);
    const theirs = await world("storage_cap", db);
    const port = reader(() => ({ raw: Buffer.from(LETTER(theirs.header)) }));
    const foreign = await refusal(liveBody(ctxOf(mine), theirs.messageId, port));
    const unknown = await refusal(liveBody(ctxOf(mine), randomUUID(), port));
    expect(foreign).toEqual({ status: 404, code: "not_found" });
    expect(unknown).toEqual(foreign);
    expect(await refusal(liveBody(ctxOf(mine), "not-a-uuid", port))).toEqual(foreign);
    expect(port.asked).toEqual([]);
  });

  it("refuses a letter whose text is kept (409) before it asks anybody anything", async () => {
    const w = await world(null);
    const port = reader(() => ({ raw: Buffer.from(LETTER(w.header)) }));
    expect(await refusal(liveBody(ctxOf(w), w.messageId, port))).toEqual({ status: 409, code: "text_kept" });
    expect(port.asked).toEqual([]);
  });

  it("gone is 410, over the ceiling 413, another letter at the place 409", async () => {
    const w = await world();
    expect(await refusal(liveBody(ctxOf(w), w.messageId, reader(() => ({ gone: true })))))
      .toEqual({ status: 410, code: "letter_gone" });
    expect(await refusal(liveBody(ctxOf(w), w.messageId, reader(() => ({ oversize: true })))))
      .toEqual({ status: 413, code: "letter_too_large" });
    expect(await refusal(liveBody(ctxOf(w), w.messageId, reader(() => ({ raw: Buffer.from(LETTER("someone-else@example.com")) })))))
      .toEqual({ status: 409, code: "letter_mismatch" });
    // A letter with no place recorded is gone without a dial.
    await w.db.delete(messageInstances).where(eq(messageInstances.messageId, w.messageId));
    const none = reader(() => ({ gone: true }));
    expect(await refusal(liveBody(ctxOf(w), w.messageId, none))).toEqual({ status: 410, code: "letter_gone" });
    expect(none.asked).toEqual([]);
  });

  it("admits sixty loads an hour per account and refuses the sixty-first; a refusal before it costs none", async () => {
    const w = await world();
    const keys = throttleKeysFor(makeTestAuthDeps().keyProvider);
    const port = { admit: liveBodyAdmitter(keys), ...reader(() => ({ raw: Buffer.from(LETTER(w.header)) })) };
    const kept = await world(null, w.db);
    expect((await refusal(liveBody(ctxOf(kept), kept.messageId, port))).status).toBe(409);
    for (let i = 0; i < LIVE_BODY_PER_HOUR; i++) await liveBody(ctxOf(w), w.messageId, port);
    expect(await refusal(liveBody(ctxOf(w), w.messageId, port))).toEqual({ status: 429, code: "rate_limited" });
    expect(port.asked).toHaveLength(LIVE_BODY_PER_HOUR);
    // The slot is keyed by the account's keyed hash, never its id.
    const keysHeld = (await w.db.select({ key: authThrottle.key }).from(authThrottle)).map((r) => r.key);
    expect(keysHeld).toContain(`live-body:${keys.client(w.accountId)}`);
    expect(keysHeld.some((k) => k.includes(w.accountId))).toBe(false);
    // Another account has its own sixty.
    const other = await world("storage_cap", w.db);
    const theirs = { admit: liveBodyAdmitter(keys), ...reader(() => ({ raw: Buffer.from(LETTER(other.header)) })) };
    await expect(liveBody(ctxOf(other), other.messageId, theirs)).resolves.toMatchObject({ html: expect.any(String) });
  });
});
