import { rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { SERVER_SENT_COPY_FIND_MS } from "@trafficflow/core/adapters/imap";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { sentUidsFor, startGmailLikePair, type GmailLikePair } from "../../../packages/core/test/adapters/_gmail-like.js";
import { serviceUp } from "@trafficflow/db/testing";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS + 30_000 });

/**
 * A LETTER SENT FROM THE LOCAL DOOR ON A GMAIL-LIKE MAILBOX IS ONE MESSAGE — in Sent and in the store.
 *
 * The desktop and phone engines send through one path (`makeSendAdapter` → `ImapAdapter.send`),
 * driven here from `POST /drafts/:id/send` over `_gmail-like.ts`: a server that files the
 * submission itself and announces `X-GM-EXT-1`. On time, the sent row is the server's copy at
 * once; late, the send is `sent` with no row, and the next sync writes the one row from that copy.
 */

const HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.IMAP_PORT ?? 3143);

const SERVER_UP = serviceUp("greenmail", `${HOST}:${PORT}`).up;

describe.skipIf(!SERVER_UP)("the local door on a server that files its own submissions", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function install(fileDelayMs: number): Promise<{
    sidecar: Sidecar; pair: GmailLikePair; auth: { user: string; pass: string }; uidValidity: string;
  }> {
    // Generated here and never printed; the fixture has authentication disabled.
    const auth = { user: `t-${randomUUID()}@trafficflow.test`, pass: randomUUID() };
    const c = new ImapFlow({ host: HOST, port: PORT, secure: false, auth, logger: false });
    await c.connect();
    await c.mailboxCreate("Sent").catch(() => undefined);
    const st = await c.status("Sent", { uidValidity: true });
    await c.logout();
    const pair = await startGmailLikePair({ upstream: { host: HOST, port: PORT }, auth, fileDelayMs });
    cleanups.push(() => pair.close());
    const dataDir = await freshDataDir("ohmail-gmail-sent-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const sidecar = await createSidecar({
      dataDir, address: auth.user, keks: { 1: randomBytes(32) },
      imap: {
        host: pair.imap.host, port: pair.imap.port, secure: false, auth,
        smtp: { host: pair.smtp.host, port: pair.smtp.port, secure: false },
      },
      machineName: "the computer that sends",
      pollIntervalMs: 60 * 60 * 1000,
      leaseStaleAfterMs: 60_000,
    });
    cleanups.push(async () => { await sidecar.stop().catch(() => undefined); });
    await sidecar.start();
    return { sidecar, pair, auth, uidValidity: String(st.uidValidity) };
  }

  async function send(sidecar: Sidecar): Promise<{ status: string; providerMessageId: string }> {
    const headers = { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" };
    const created = await sidecar.handle(new Request("http://sidecar/drafts", {
      method: "POST", headers,
      body: JSON.stringify({
        mailboxId: sidecar.world.mailboxId, subject: "one letter", html: "<p>once</p>",
        to: [{ name: null, address: "someone@elsewhere.test" }],
      }),
    }));
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = await created.json() as { id: string };
    const res = await sidecar.handle(new Request(`http://sidecar/drafts/${id}/send`, {
      method: "POST", headers: { ...headers, "idempotency-key": `send-${randomUUID()}` }, body: "{}",
    }));
    const body = await res.json() as { status: string; providerMessageId: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body;
  }

  async function sentRows(sidecar: Sidecar, messageId: string): Promise<Array<{ ref: string; folder: string }>> {
    const inner = messageId.replace(/[<>]/g, "");
    const rows = await sidecar.db.select().from(messages).where(eq(messages.mailboxId, sidecar.world.mailboxId));
    return rows
      .filter((r) => (r.messageIdHeader ?? "").includes(inner))
      .map((r) => r.nativeLocator as { ref: string; folder: string });
  }

  it("on time: the send records the server's copy, and the next sync adds no second row", async () => {
    const { sidecar, pair, auth, uidValidity } = await install(0);
    const sent = await send(sidecar);
    expect(sent.status).toBe("sent");
    await pair.whenFiled(1);
    expect(await sentUidsFor({ host: HOST, port: PORT }, auth, sent.providerMessageId)).toEqual([pair.filedUids[0]]);
    const at = { folder: "Sent", ref: `${uidValidity}:${pair.filedUids[0]}` };
    expect(await sentRows(sidecar, sent.providerMessageId)).toEqual([at]);
    await sidecar.syncUntilQuiet();
    expect(await sentRows(sidecar, sent.providerMessageId)).toEqual([at]);
  });

  it("late past the bound: sent with no row, then the next sync writes the ONE row at the server's copy", async () => {
    const { sidecar, pair, auth, uidValidity } = await install(SERVER_SENT_COPY_FIND_MS + 1_500);
    const sent = await send(sidecar);
    expect(sent.status).toBe("sent");
    expect(await sentRows(sidecar, sent.providerMessageId)).toEqual([]);
    await pair.whenFiled(1);
    await sidecar.syncUntilQuiet();
    expect(await sentUidsFor({ host: HOST, port: PORT }, auth, sent.providerMessageId)).toEqual([pair.filedUids[0]]);
    expect(await sentRows(sidecar, sent.providerMessageId))
      .toEqual([{ folder: "Sent", ref: `${uidValidity}:${pair.filedUids[0]}` }]);
  });
});
