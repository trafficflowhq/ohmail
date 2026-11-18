import type { MessageStateDTO } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, triagePiles,
} from "@ohmail/client-engine";
import { messages } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";

/**
 * A LETTER DELETED ON THE MAIL SERVER LEAVES ANSWER LATER, end to end on the local
 * door: a real IMAP server, the engine's own sync and reaper, and the window's client engine over
 * the bridge. Two letters are parked; another client deletes and expunges one; after ONE sync the
 * pile, its count and the mirror's claim all say one. The Cloud door runs the same reaper and the
 * same pile read, which the Postgres twin `packages/services/test/triage-pile-gone-letter.pg.test.ts`
 * holds.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);

interface World {
  sidecar: Sidecar; host: StdioHost; client: StdioClient; dataDir: string; raw: ImapFlow; user: string;
}
const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    w.client.close();
    w.host.stop();
    await w.raw.logout().catch(() => undefined);
    await w.sidecar.stop().catch(() => undefined);
    rmSync(w.dataDir, { recursive: true, force: true });
  }
});

async function standUp(): Promise<World> {
  const user = `t-${randomUUID()}@trafficflow.test`;
  const cfg = { host: IMAP_HOST, port: IMAP_PORT, secure: false as const, auth: { user, pass: "test" } };
  const dataDir = await freshDataDir("ohmail-answer-later-expunge-");
  const sidecar = await createSidecar({
    dataDir, imap: cfg, address: user, displayName: "This Mac", pollIntervalMs: 60 * 60 * 1000,
  });
  await grantOrganizeConsent(sidecar);
  const toHost = new PassThrough({ highWaterMark: 1024 });
  const toClient = new PassThrough({ highWaterMark: 1024 });
  const host = serveOverStdio({ handle: (req) => sidecar.handle(req), input: toHost, output: toClient });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  await host.ready({
    baseUrl: "http://sidecar", sessionToken: sidecar.sessionToken, accountId: sidecar.world.accountId,
    userId: sidecar.world.userId, mailboxId: sidecar.world.mailboxId, credentialState: await sidecar.credentialState(),
  });
  const raw = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
  await raw.connect();
  const w: World = { sidecar, host, client, dataDir, raw, user };
  worlds.push(w);
  return w;
}

const eml = (from: string, to: string, subject: string, messageId: string): string => [
  `Message-ID: <${messageId}>`, `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
  "Content-Type: text/plain; charset=utf-8", "", "A letter to answer later.",
].join("\r\n");

describe("Answer Later forgets a letter the server deleted", () => {
  it("one sync after another client expunges a parked letter, the pile and its count drop by one", async () => {
    const w = await standUp();
    // From the mailbox's own address, as the finding's letter was: it stays in INBOX, no gate.
    const ids = [`later-a-${randomUUID()}@trafficflow.test`, `later-b-${randomUUID()}@trafficflow.test`];
    for (const [i, mid] of ids.entries()) await w.raw.append("INBOX", eml(w.user, w.user, `later ${i}`, mid));
    await w.sidecar.start();

    const rowOf = async (mid: string) =>
      (await w.sidecar.db.select().from(messages).where(eq(messages.messageIdHeader, mid)))[0]!;
    const [a, b] = [await rowOf(ids[0]!), await rowOf(ids[1]!)];
    const auth = { authorization: `Bearer ${w.sidecar.sessionToken}`, "content-type": "application/json" };
    for (const m of [a, b]) {
      const res = await w.client.fetch(`/messages/${m.id}/triage`, {
        method: "POST", headers: auth, body: JSON.stringify({ state: "reply_later" }),
      });
      expect(res.status, "parking the letter through the route the button calls").toBe(200);
    }

    const engine = new OhmailEngine({
      adapter: new HttpAdapter({ baseUrl: "http://sidecar", fetch: w.client.fetch, headers: () => ({ authorization: auth.authorization }) }),
      store: new MemoryMirrorStore(),
    });
    await engine.start();
    const pile = () => triagePiles(engine.read()).replyLater.map((e) => e.messageId);
    expect(new Set(pile()), "both letters are in Answer Later before the delete").toEqual(new Set([a.id, b.id]));
    const claimOf = (id: string) => engine.store.entries<MessageStateDTO>("message_state")
      .find((r) => r.entity?.messageId === id);
    expect(claimOf(a.id)?.entity, "the mirror holds the claim as its own record").toBeTruthy();

    // Another mail program deletes and expunges the first letter.
    const lock = await w.raw.getMailboxLock("INBOX");
    try {
      const uids = await w.raw.search({ header: { "message-id": ids[0]! } }, { uid: true });
      expect(Array.isArray(uids) ? uids.length : 0, "the letter is in INBOX on the server").toBe(1);
      await w.raw.messageDelete(uids as number[], { uid: true });
    } finally {
      lock.release();
    }

    await w.sidecar.syncUntilQuiet();
    const [gone] = await w.sidecar.db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.id, a.id));
    expect(gone?.deletedAt, "the engine's reaper tombstoned the expunged letter").not.toBeNull();
    const served = await (await w.client.fetch("/triage?state=reply_later", { headers: auth })).json() as { items: Array<{ id: string }> };
    expect(served.items.map((m) => m.id), "the engine's own pile read lists one").toEqual([b.id]);

    await engine.syncOnce();
    expect(pile(), "the window's pile lists the letter that exists").toEqual([b.id]);
    expect(triagePiles(engine.read()).replyLater.some((e) => e.title === a.id), "no row reads an id").toBe(false);
    expect(claimOf(a.id), "the mirror's claim left with its letter").toBeUndefined();
  }, 120_000);
});
