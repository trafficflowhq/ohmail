import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar, type SidecarConfig } from "../src/engine.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";

/**
 * THE DESKTOP'S LOCAL ENGINE OFFERS A PASSING DIAL FAULT AGAIN, AND THE REPLAY SENDS ONCE. The real
 * sidecar over its stdio bridge, GreenMail as the mail server (3143/3025), the real `SendService`
 * and `ImapAdapter`; the send's first dial meets a connection that ends before the sign-in. The
 * first answer is 424 with `retryable: true` and `Retry-After`, carried across the bridge; the same
 * key pressed again sends, and the Sent folder holds exactly one copy under the minted id. Before:
 * the first answer was a 500 and the replay was told the send failed.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SMTP_HOST = process.env.SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);

interface Launch { sidecar: Sidecar; host: StdioHost; client: StdioClient }
const launches: Launch[] = [];
const dataDirs: string[] = [];
const raw: ImapFlow[] = [];

afterEach(async () => {
  for (const l of launches.splice(0)) {
    l.client.close();
    l.host.stop();
    await l.sidecar.stop().catch(() => undefined);
  }
  for (const c of raw.splice(0)) await c.logout().catch(() => undefined);
  for (const d of dataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function launch(user: string, adapterFactory: (cfg: ImapConfig) => unknown): Promise<Launch> {
  const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-sidecar-rearm-"));
  dataDirs.push(dataDir);
  const sidecar = await createSidecar({
    dataDir,
    imap: {
      host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user, pass: "test" },
      smtp: { host: SMTP_HOST, port: SMTP_PORT, secure: false },
    },
    address: user,
    displayName: "This Mac",
    keks: { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) },
    adapterFactory: adapterFactory as unknown as SidecarConfig["adapterFactory"],
    pollIntervalMs: 60 * 60 * 1000,
  });
  const toHost = new PassThrough({ highWaterMark: 1024 });
  const toClient = new PassThrough({ highWaterMark: 1024 });
  const host = serveOverStdio({ handle: (req) => sidecar.handle(req), input: toHost, output: toClient });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  await host.ready({
    baseUrl: "http://sidecar", sessionToken: sidecar.sessionToken, accountId: sidecar.world.accountId,
    userId: sidecar.world.userId, mailboxId: sidecar.world.mailboxId, credentialState: await sidecar.credentialState(),
  });
  const l = { sidecar, host, client };
  launches.push(l);
  return l;
}

const call = (l: Launch, path: string, init: { method: string; body?: unknown; key?: string }) =>
  l.client.fetch(path, {
    method: init.method,
    headers: {
      authorization: `Bearer ${l.sidecar.sessionToken}`, "content-type": "application/json",
      ...(init.key ? { "idempotency-key": init.key } : {}),
    },
    body: JSON.stringify(init.body ?? {}),
  });

async function sentCopies(user: string, messageId: string): Promise<number> {
  const c = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user, pass: "test" }, logger: false });
  await c.connect();
  raw.push(c);
  const lock = await c.getMailboxLock("Sent");
  try {
    const uids = await c.search({ header: { "message-id": messageId.replace(/[<>]/g, "") } }, { uid: true });
    return Array.isArray(uids) ? uids.length : 0;
  } finally { lock.release(); }
}

describe("the desktop's local engine re-arms a send whose first dial met a passing fault", () => {
  it("424 retryable with Retry-After across the bridge, then the same key sends once", async () => {
    const user = `t-${randomUUID()}@trafficflow.test`;
    let armed = false;
    let sendDials = 0;
    const l = await launch(user, (cfg) => {
      const adapter = new ImapAdapter(cfg);
      // Armed just before the first press: the send's own dial ends before the sign-in, once.
      if (armed && cfg.smtp) {
        sendDials += 1;
        if (sendDials === 1) {
          adapter.connect = async () => { throw Object.assign(new Error("the IMAP connection closed"), { code: "EIMAPCLOSED" }); };
        }
      }
      return adapter;
    });
    const entered = await call(l, `/mailboxes/${l.sidecar.world.mailboxId}`, {
      method: "PATCH", body: { imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, user, pass: "test" } },
    });
    expect(entered.status).toBe(200);
    await l.sidecar.start();

    const created = await call(l, "/drafts", {
      method: "POST",
      body: { mailboxId: l.sidecar.world.mailboxId, subject: "the list", body: "See below.", to: [{ name: null, address: "you@example.com" }] },
    });
    expect(created.status).toBe(201);
    const draft = await created.json() as { id: string };
    const key = `send-${randomUUID()}`;

    armed = true;
    const first = await call(l, `/drafts/${draft.id}/send`, { method: "POST", key });
    const refused = await first.json() as { error?: { code?: string; retryable?: boolean } };
    expect({ status: first.status, code: refused.error?.code, retryable: refused.error?.retryable, wait: first.headers.get("retry-after") })
      .toEqual({ status: 424, code: "send_unreachable", retryable: true, wait: "2" });

    const second = await call(l, `/drafts/${draft.id}/send`, { method: "POST", key });
    const sent = await second.json() as { status?: string; providerMessageId?: string };
    expect({ status: second.status, wire: sent.status }).toEqual({ status: 200, wire: "sent" });
    expect(sendDials).toBe(2);
    expect(await sentCopies(user, sent.providerMessageId!), "not exactly one copy in Sent").toBe(1);
  }, 120_000);
});
