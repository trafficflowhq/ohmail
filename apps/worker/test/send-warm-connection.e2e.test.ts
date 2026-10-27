import { createServer, connect, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import {
  SendConnections, UNMETERED_STORAGE_CAP, type OpenSendAdapter, type StorageCap, type WarmSendAdapter,
} from "@trafficflow/core/mail";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drafts, mailboxes } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { makeDb } from "@trafficflow/db/cloud";
import { SendService, type ServiceContext } from "@trafficflow/services";
import { greenmailPorts, rawClient, refuseDriftedSharedDb, uidInFolder, dbUrlFor } from "./_workerenv.js";

const DB_URL = dbUrlFor(import.meta.url);

/**
 * read off the WIRE. Every press of Send dialled, handshook,
 * LOGINed and LISTed a fresh IMAP connection for one APPEND. Three consecutive presses through
 * the keeper over a REAL `ImapAdapter` and the real `SendService` (GreenMail, Postgres) now cost
 * ONE LOGIN: a TCP proxy between the adapter and GreenMail's IMAP port counts
 * the LOGIN commands it forwards. Measured before the fix: three. The count is a count — no
 * LOGIN line is logged, printed or kept. THE MUTATION THAT MAKES THIS RED: the reuse branch in
 * `SendConnections.open` (`if (entry.real.isLive()) return this.lease(entry);`) inverted — (1)
 * reads 3. Watched fail and restored through `kit/mutate/mutation-control.sh`.
 */

const svc = new SendService();

/** A counting proxy in front of GreenMail IMAP: forwards bytes, counts `<tag> LOGIN` lines. */
async function loginCountingProxy(upstream: { host: string; port: number }) {
  const state = { logins: 0, pairs: [] as Array<{ client: Socket; server: Socket }> };
  const server: Server = createServer((client) => {
    const up = connect(upstream.port, upstream.host);
    state.pairs.push({ client, server: up });
    let head = "";
    client.on("data", (chunk: Buffer) => {
      // Line-scan the client→server stream for the command word only; the arguments are never read.
      head += chunk.toString("latin1");
      const lines = head.split("\r\n");
      head = lines.pop() ?? "";
      for (const line of lines) if (/^\S+ LOGIN /i.test(line)) state.logins += 1;
      up.write(chunk);
    });
    up.on("data", (chunk: Buffer) => { client.write(chunk); });
    const down = (): void => { client.destroy(); up.destroy(); };
    client.on("close", down); up.on("close", down);
    client.on("error", down); up.on("error", down);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    port, state,
    /** Kill every proxied connection from the server side — the socket dies under the client. */
    dropAll() { for (const p of state.pairs.splice(0)) { p.server.destroy(); p.client.destroy(); } },
    async close() { await new Promise<void>((r) => server.close(() => r())); },
  };
}

async function fixture(proxyPort: number) {
  await refuseDriftedSharedDb();
  const db = makeDb(DB_URL);
  const p = greenmailPorts();
  const accountId = randomUUID();
  const user = `w-${randomUUID()}@trafficflow.test`;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: user }).returning();
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => new Date(), requestId: "r" };
  // A DISTINCT message per press: the duplicate-content fence refuses the same words twice
  // within its window, which would read as a failed press rather than the LOGIN count.
  const draft = async (): Promise<string> => {
    const [d] = await db.insert(drafts).values({
      accountId, mailboxId: mb!.id,
      subject: `warm ${randomUUID()}`, body: "the same connection",
      to: [{ name: null, address: "recipient@trafficflow.test" }], status: "draft",
    }).returning();
    return d!.id;
  };
  const cfg = {
    host: p.imapHost, port: p.imapPort, secure: false, auth: { user, pass: "test" },
    smtp: { host: p.smtpHost, port: p.smtpPort, secure: false }, sentDomain: "trafficflow.test",
  };
  // THE DIAL, shaped as the production factory shapes one: a fresh `ImapAdapter` at the proxy,
  // connected, wrapped in the same literal with `isLive` forwarded — the keeper's admission.
  const dial = async (): Promise<WarmSendAdapter> => {
    const adapter = new ImapAdapter({ ...cfg, host: "127.0.0.1", port: proxyPort });
    await adapter.connect();
    return {
      send: async (msg) => {
        const res = await adapter.send(msg);
        return res.sentLocator === null
          ? { providerMessageId: res.providerMessageId }
          : { providerMessageId: res.providerMessageId, appended: { locator: res.sentLocator, raw: res.raw } };
      },
      messageInSent: (id) => adapter.messageInSent(id),
      close: () => adapter.close(),
      forceClose: () => { adapter.forceClose(); },
      isLive: () => adapter.isLive(),
    };
  };
  const through = (keep: SendConnections): OpenSendAdapter => (id) => keep.open(id, dial);
  // The sent-copy projection runs (it consumes the APPEND's answer), so the line it logs on a
  // missing cap is not mistaken for a fault of the kept connection.
  const sendDeps = (openSendAdapter: OpenSendAdapter) =>
    ({ openSendAdapter, resolveStorageCap: async (): Promise<StorageCap> => UNMETERED_STORAGE_CAP });
  return { db, ctx, mailboxId: mb!.id, draft, cfg, through, sendDeps };
}

describe("send e2e — three presses, one LOGIN (GreenMail through a counting proxy + Postgres)", () => {
  let proxy: Awaited<ReturnType<typeof loginCountingProxy>>;
  const keepers: SendConnections[] = [];
  beforeAll(async () => {
    await runMigrations(DB_URL);
    const p = greenmailPorts();
    proxy = await loginCountingProxy({ host: p.imapHost, port: p.imapPort });
  });
  afterAll(async () => {
    for (const k of keepers) await k.closeAll();
    proxy.dropAll();
    await proxy.close();
  });

  it("(0) the counter counts: one raw login through the proxy reads 1 (the positive control)", async () => {
    const f = await fixture(proxy.port);
    const before = proxy.state.logins;
    const c = await rawClient({ ...f.cfg, host: "127.0.0.1", port: proxy.port });
    await c.logout();
    expect(proxy.state.logins - before).toBe(1);
  });

  it("(1) three consecutive presses through makeSendAdapter cost ONE LOGIN, and all three land in Sent", async () => {
    const f = await fixture(proxy.port);
    const keep = new SendConnections();
    keepers.push(keep);
    const openSendAdapter = f.through(keep);
    const before = proxy.state.logins;
    const ids: string[] = [];
    for (let press = 1; press <= 3; press++) {
      const res = await svc.send(f.ctx, await f.draft(), `warm-${randomUUID()}`, f.sendDeps(openSendAdapter));
      expect(res.status, `press ${press}`).toBe("sent");
      ids.push(res.providerMessageId!.replace(/[<>]/g, ""));
    }
    expect(proxy.state.logins - before).toBe(1);
    expect(keep.size()).toBe(1);
    // The APPEND really happened on the kept connection, three times: every copy is in Sent.
    const c = await rawClient(f.cfg);
    for (const id of ids) expect((await uidInFolder(c, "Sent", id)).length, id).toBeGreaterThan(0);
    await c.logout();
  }, 45_000);

  it("(2) a kept connection the server drops is re-dialled — the next press LOGINs once more and sends", async () => {
    const f = await fixture(proxy.port);
    const keep = new SendConnections();
    keepers.push(keep);
    const openSendAdapter = f.through(keep);
    const before = proxy.state.logins;
    const one = await svc.send(f.ctx, await f.draft(), `drop-${randomUUID()}`, f.sendDeps(openSendAdapter));
    expect(one.status).toBe("sent");
    expect(proxy.state.logins - before).toBe(1);
    // The socket dies under the idle connection, the way a server's autologout or a NAT does.
    const gone = new Promise<void>((r) => { const p = proxy.state.pairs.at(-1)!; p.client.once("close", () => r()); });
    proxy.dropAll();
    await gone;
    await new Promise((r) => setTimeout(r, 50));    // imapflow's own close listener runs a tick later
    const two = await svc.send(f.ctx, await f.draft(), `drop-${randomUUID()}`, f.sendDeps(openSendAdapter));
    expect(two.status).toBe("sent");
    expect(proxy.state.logins - before).toBe(2);    // re-dialled: one more LOGIN, not a failed send
  }, 45_000);

  it("(3) the drafts and reservations of every press read `sent` (nothing was answered for a send that did not happen)", async () => {
    const f = await fixture(proxy.port);
    const keep = new SendConnections();
    keepers.push(keep);
    const openSendAdapter = f.through(keep);
    const draftId = await f.draft();
    await svc.send(f.ctx, draftId, `state-${randomUUID()}`, f.sendDeps(openSendAdapter));
    const [d] = await f.db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("sent");
  }, 30_000);
});
