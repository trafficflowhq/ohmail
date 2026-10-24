import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { drafts, mailboxCredentials, outboundSends } from "@trafficflow/db";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { SendConnections, type KeepTimers, type OpenSendAdapter } from "@trafficflow/core/mail";
import { makeSendAdapter } from "../src/send-adapter.js";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

/**
 * A SEND WHOSE MAIL SERVER CANNOT BE REACHED IS A REFUSAL, NEVER A 500. Driven through the real
 * route, the real `makeSendAdapter` and a real socket: a refused port and a server that never
 * greets. The answer is 424 `send_unreachable`, the send recorded `failed`, the draft an ordinary
 * draft again, and no fault row for the 5xx alerts; the same key is offered again twice and the
 * third attempt is final. Controls: an internal fault still answers 500 and is counted; an SMTP 550
 * for the message keeps `unverified`.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const timers: KeepTimers = { set: () => 0, clear: () => undefined };
const open: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listen(server: net.Server): Promise<number> {
  server.on("connection", (s) => { sockets.push(s); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  open.push(server);
  return (server.address() as net.AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Accepts the connection and never greets — the silent server a timeout is made of. */
const silentServer = (): Promise<number> => listen(net.createServer(() => { /* no greeting */ }));

/** A submission server that takes the session and refuses the one recipient with a 550. */
function refusingSmtp(): Promise<number> {
  return listen(net.createServer((sock) => {
    sock.write("220 fake ESMTP\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i).toUpperCase();
        buf = buf.slice(i + 2);
        if (line.startsWith("EHLO") || line.startsWith("HELO")) sock.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (line.startsWith("AUTH")) sock.write("235 2.7.0 ok\r\n");
        else if (line.startsWith("MAIL FROM")) sock.write("250 2.1.0 ok\r\n");
        else if (line.startsWith("RCPT TO")) sock.write("550 5.1.1 no such user\r\n");
        else if (line.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 ok\r\n");
      }
    });
  }));
}

async function world(over: { sendAdapter?: (deps: () => ApiDeps) => OpenSendAdapter } = {}) {
  let ref: ApiDeps | null = null;
  const made = await makeDeps(FIXED_NOW, {}, over.sendAdapter ? { sendAdapter: over.sendAdapter(() => ref!) } : {});
  // `makeDeps` stubs the IMAP dial for every other route test; this file is about the dial.
  vi.restoreAllMocks();
  ref = made.deps;
  const faults: Array<{ status: number; errorClass: string }> = [];
  made.deps.faultLog = { record: async (f) => { faults.push({ status: f.status, errorClass: f.errorClass }); } };
  const s = await seedSession(made.db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(made.db, { accountId: s.accountId, address: "u@outage.example" });
  const [d] = await made.db.insert(drafts).values({
    accountId: s.accountId, mailboxId, subject: "Re: hi", body: "Thanks!",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
  } as never).returning();
  return { ...made, s, mailboxId, draftId: d!.id, faults };
}

async function credentials(
  w: Awaited<ReturnType<typeof world>>, imapPort: number, smtpPort: number,
): Promise<void> {
  for (const [transport, port] of [["imap", imapPort], ["smtp", smtpPort]] as const) {
    const enc = await w.deps.keyProvider.encrypt(`${transport}-pass`);
    await w.db.insert(mailboxCredentials).values({
      mailboxId: w.mailboxId, transport, secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "127.0.0.1", port, secure: false, user: "u@outage.example" },
    });
  }
}

const press = (w: Awaited<ReturnType<typeof world>>, key: string): Promise<Response> =>
  H(req("POST", `/drafts/${w.draftId}/send`, { bearer: w.s.token, headers: { "idempotency-key": key } }), w.deps);

/**
 * The outage answered three times under one key: offered again after 2 s and after 5 s, then final.
 * Each answer is the 424 refusal with its sentence, the row `failed` and the draft an ordinary draft;
 * the fourth press is told the send failed and dials nothing.
 */
async function assertOfferedThenFinal(w: Awaited<ReturnType<typeof world>>, key: string): Promise<void> {
  for (const [n, retryable, wait] of [[1, true, "2"], [2, true, "5"], [3, false, null]] as const) {
    const res = await press(w, key);
    const body = await res.json() as { error?: { code?: string; message?: string; retryable?: boolean } };
    expect({ attempt: n, status: res.status, code: body.error?.code, retryable: body.error?.retryable, wait: res.headers.get("retry-after") })
      .toEqual({ attempt: n, status: 424, code: "send_unreachable", retryable, wait });
    expect(body.error?.message).toMatch(/not sent.*could not be reached/i);
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect({ status: row!.status, attempts: row!.attempts }).toEqual({ status: "failed", attempts: n });
    const [d] = await w.db.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect({ status: d!.status, sendKey: d!.sendKey }).toEqual({ status: "draft", sendKey: null });
  }
  expect(w.faults, "an outage of the person's mail server was counted as our 5xx").toEqual([]);
  // Three attempts spent the key: a fourth press is told the send failed.
  const again = await press(w, key);
  expect(again.status).toBe(409);
  expect((await again.json() as { status?: string }).status).toBe("failed");
}

describe("POST /drafts/:id/send when the mail server cannot be reached", () => {
  it("a REFUSED dial answers 424 send_unreachable through the production factory, offered again twice", async () => {
    const w = await world();
    await credentials(w, await closedPort(), await closedPort());
    await assertOfferedThenFinal(w, "refused-1");
  });

  it("a server that never GREETS answers the same refusal, not a 500, offered again twice", async () => {
    const short = { connectionMs: 400, greetingMs: 400, socketMs: 5_000 };
    const w = await world({
      sendAdapter: (deps) => (id: string) => makeSendAdapter(deps(), id, { timeouts: short }, undefined, new SendConnections({ timers })),
    });
    await credentials(w, await silentServer(), await closedPort());
    await assertOfferedThenFinal(w, "silent-1");
  });

  it("CONTROL: a fault of ours in the same window still answers 500 and is counted", async () => {
    const w = await world({ sendAdapter: () => async () => { throw new TypeError("cannot read properties of undefined"); } });
    const res = await press(w, "ours-1");
    expect(res.status).toBe(500);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe("internal");
    expect(w.faults.map((f) => f.status)).toEqual([500]);
  });

  it("CONTROL: an SMTP 550 for the recipient is the server's refusal — not unreachable, not our fault", async () => {
    const fakeImap = {
      list: async () => [{ path: "INBOX", delimiter: "/", flags: new Set<string>() }],
      on: () => undefined,
      logout: async () => undefined,
      close: () => undefined,
      getMailboxLock: async () => { throw new Error("no such mailbox"); },
    };
    const w = await world({
      sendAdapter: (deps) => (id: string) => makeSendAdapter(deps(), id, {},
        (cfg: ImapConfig) => new ImapAdapter(cfg, { client: fakeImap as never }), new SendConnections({ timers })),
    });
    await credentials(w, await closedPort(), await refusingSmtp());
    const res = await press(w, "rcpt-550");
    expect(res.status).toBe(424);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe("send_refused_by_server");
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status).toBe("failed");
    expect(w.faults).toEqual([]);
  });
});
