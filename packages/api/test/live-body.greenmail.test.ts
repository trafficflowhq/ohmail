import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  accountStorage, changeLog, messageBodies, messageInstances, messageSearch, messages,
} from "@trafficflow/db";
import { liveBody, ServiceError, type ServiceContext } from "@trafficflow/services/mail";
import { greenmailEndpoint, readLaneGreenmail } from "../../../scripts/lib/lane-greenmail-env.mjs";
import { liveBodyReader } from "../src/live-body-door.js";
import { serverState, world, type Shape, type World } from "./_self-check-world.js";

/**
 * LOAD IT NOW AGAINST GREENMAIL: the letter's text comes from the mail server through the API's own
 * door (the admitted connection, `BODY.PEEK`, the epoch checked per place), and nothing moves on
 * either side: no row in the store, no `\Seen` on the server.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const gm = greenmailEndpoint(process.env, readLaneGreenmail(REPO_ROOT));
const shape: Shape = {
  name: "GreenMail", host: gm.imapHost, port: gm.imapPort, user: () => `lb-${randomUUID()}@trafficflow.test`, pass: "test",
};

interface FixtureClient {
  mailbox: unknown;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  mailboxCreate(path: string): Promise<unknown>;
  append(path: string, raw: string, flags: string[]): Promise<unknown>;
  getMailboxLock(path: string, opts?: { readOnly?: boolean }): Promise<{ release(): void }>;
  fetch(range: string, q: { uid: true; flags: true }, o: { uid: true }): AsyncIterable<{ uid: number; flags?: Set<string> }>;
}
const { ImapFlow } = createRequire(new URL("../../core/package.json", import.meta.url))("imapflow") as {
  ImapFlow: new (o: Record<string, unknown>) => FixtureClient;
};

async function client(user: string): Promise<FixtureClient> {
  const c = new ImapFlow({ host: shape.host, port: shape.port, secure: false, auth: { user, pass: shape.pass }, logger: false });
  await c.connect();
  return c;
}

const LETTER = (id: string): string => [
  `Message-ID: <${id}>`, "From: tom@example.net", "To: sam@example.com", "Subject: Kitchen plans",
  "Date: Wed, 14 Jun 2017 16:20:00 +0000", "Content-Type: text/plain; charset=utf-8", "",
  "Hi Sam, here is the final version of the kitchen plans.", "",
].join("\r\n");

/** The letter, unread, in INBOX and in Archive. */
async function plant(user: string, raw: string): Promise<void> {
  const c = await client(user);
  try {
    await c.mailboxCreate("Archive");
    await c.append("INBOX", raw, []);
    await c.append("Archive", raw, []);
  } finally {
    await c.logout().catch(() => c.close());
  }
}

/** Every UID of a folder that carries `\Seen`. */
async function seenIn(user: string, folder: string): Promise<number[]> {
  const c = await client(user);
  try {
    const lock = await c.getMailboxLock(folder, { readOnly: true });
    try {
      const out: number[] = [];
      for await (const m of c.fetch("1:*", { uid: true, flags: true }, { uid: true })) if (m.flags?.has("\\Seen")) out.push(m.uid);
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await c.logout().catch(() => c.close());
  }
}

/** The store's emptied letter at the two places the server holds it. */
async function emptied(w: World, header: string, places: Array<{ folder: string; epoch: string; uid: number; primary: boolean }>): Promise<string> {
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: `<${header}>`, bodyHash: header, dedupKey: header,
    subject: "Kitchen plans", fromAddress: "tom@example.net", snippet: "Hi Sam",
  }).returning({ id: messages.id });
  await w.db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, withheldReason: "storage_cap" });
  for (const p of places) {
    await w.db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder: p.folder,
      uidvalidity: BigInt(p.epoch), uid: p.uid, isPrimary: p.primary,
    });
  }
  return m!.id;
}

const ctxOf = (w: World): ServiceContext =>
  ({ db: w.db, accountId: w.accountId, userId: null, now: () => new Date(), requestId: "live-body" }) as unknown as ServiceContext;

async function stored(w: World, id: string): Promise<string> {
  return JSON.stringify({
    body: await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, id)),
    counter: await w.db.select().from(accountStorage),
    changes: (await w.db.select().from(changeLog)).length,
    words: (await w.db.select().from(messageSearch)).length,
  });
}

describe("Load it now against GreenMail", { timeout: 30_000 }, () => {
  it("reads the letter from its primary place, and leaves the store and the server's \\Seen as they were", async () => {
    const user = shape.user();
    const header = `lb-${randomUUID()}@example.com`;
    await plant(user, LETTER(header));
    const st = await serverState(shape, user, ["INBOX", "Archive"]);
    const w = await world(shape, user);
    const id = await emptied(w, header, [
      { folder: "INBOX", epoch: st.INBOX!.epoch, uid: st.INBOX!.uids[0]!, primary: true },
      { folder: "Archive", epoch: st.Archive!.epoch, uid: st.Archive!.uids[0]!, primary: false },
    ]);
    const before = await stored(w, id);
    const body = await liveBody(ctxOf(w), id, { read: liveBodyReader(w.deps) });
    expect(body.text).toContain("here is the final version of the kitchen plans");
    expect(await stored(w, id), "the load wrote to the store").toBe(before);
    expect(await seenIn(user, "INBOX"), "the load marked the letter read").toEqual([]);
    expect(await seenIn(user, "Archive")).toEqual([]);
  });

  it("a place under another epoch passes to the next; no place holding it is 410", async () => {
    const user = shape.user();
    const header = `lb-${randomUUID()}@example.com`;
    await plant(user, LETTER(header));
    const st = await serverState(shape, user, ["INBOX", "Archive"]);
    const w = await world(shape, user);
    const stale = String(BigInt(st.INBOX!.epoch) + 1n);
    const id = await emptied(w, header, [
      { folder: "INBOX", epoch: stale, uid: st.INBOX!.uids[0]!, primary: true },
      { folder: "Archive", epoch: st.Archive!.epoch, uid: st.Archive!.uids[0]!, primary: false },
    ]);
    expect((await liveBody(ctxOf(w), id, { read: liveBodyReader(w.deps) })).text).toContain("kitchen plans");
    await w.db.update(messageInstances).set({ uid: 9_999 }).where(eq(messageInstances.messageId, id));
    const gone = await liveBody(ctxOf(w), id, { read: liveBodyReader(w.deps) }).then(() => null, (e: unknown) => e);
    expect(gone).toBeInstanceOf(ServiceError);
    expect((gone as ServiceError).httpStatus).toBe(410);
    expect(await seenIn(user, "Archive")).toEqual([]);
  });
});
