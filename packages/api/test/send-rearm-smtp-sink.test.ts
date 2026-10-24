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
 * THE SMTP LEG, AGAINST A LOOPBACK SINK THAT FAILS ONCE. Through the real route and the production
 * factory (its IMAP leg a double): a 454 at AUTH is the server's "not now", offered again under the
 * same key and sent once; a 535 is a refusal, final at one AUTH. A 450 at RCPT came before any data
 * and is "not now" too. Everything after the end of the message was released stays on the ambiguous
 * path whatever the server answered — data taken and the connection dropped, a 4xx or 5xx after
 * DATA — never `failed`, never re-armed: the sink sees one DATA transaction and the replay dials
 * nothing. A close before the greeting released nothing, so it is a dropped send, final.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const timers: KeepTimers = { set: () => 0, clear: () => undefined };
const SHORT = { connectionMs: 600, greetingMs: 600, socketMs: 1_500 };
const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

interface Script {
  /** The n-th AUTH's answer (1-based), or `undefined` for 235. */
  auth?: (n: number) => string | undefined;
  rcpt?: (n: number) => string | undefined;
  /** What happens at the end of the n-th DATA: a reply line, or `drop` to close without one. */
  afterData?: (n: number) => string | "drop" | undefined;
  /** Close a connection before the greeting (the n-th connection). */
  closeBeforeGreeting?: (n: number) => boolean;
}

async function sink(script: Script) {
  const seen = { connections: 0, auths: 0, rcpts: 0, datas: 0, messages: 0 };
  const server = net.createServer((sock) => {
    sockets.push(sock);
    seen.connections += 1;
    if (script.closeBeforeGreeting?.(seen.connections)) { sock.destroy(); return; }
    sock.write("220 sink ESMTP\r\n");
    let buf = "";
    let inData = false;
    sock.on("error", () => sock.destroy());
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (raw === ".") {
            inData = false;
            seen.messages += 1;
            const then = script.afterData?.(seen.messages);
            if (then === "drop") { sock.destroy(); return; }
            sock.write(`${then ?? "250 2.0.0 queued"}\r\n`);
          }
          continue;
        }
        const line = raw.toUpperCase();
        if (line.startsWith("EHLO")) sock.write("250-sink\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (line.startsWith("AUTH")) { seen.auths += 1; sock.write(`${script.auth?.(seen.auths) ?? "235 2.7.0 ok"}\r\n`); }
        else if (line.startsWith("RCPT TO")) { seen.rcpts += 1; sock.write(`${script.rcpt?.(seen.rcpts) ?? "250 2.1.5 ok"}\r\n`); }
        else if (line.startsWith("DATA")) { seen.datas += 1; inData = true; sock.write("354 go\r\n"); }
        else if (line.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  servers.push(server);
  return { port: (server.address() as net.AddressInfo).port, seen };
}

/** The IMAP leg as a double: a Sent folder that holds nothing, so the Sent check answers "not there". */
function fakeImap() {
  return {
    list: async () => [
      { path: "INBOX", delimiter: "/", flags: new Set<string>() },
      { path: "Sent", delimiter: "/", flags: new Set<string>(), specialUse: "\\Sent" },
    ],
    on: () => undefined,
    logout: async () => undefined,
    close: () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async () => [],
  };
}

async function world(smtpPort: number) {
  let ref: ApiDeps | null = null;
  const factory: OpenSendAdapter = (id: string) => makeSendAdapter(ref!, id, { timeouts: SHORT },
    (cfg: ImapConfig) => new ImapAdapter(cfg, { client: fakeImap() as never }), new SendConnections({ timers }));
  const made = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
  vi.restoreAllMocks();
  ref = made.deps;
  const s = await seedSession(made.db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(made.db, { accountId: s.accountId, address: "u@sink.example" });
  for (const [transport, port] of [["imap", await closedPort()], ["smtp", smtpPort]] as const) {
    const enc = await made.deps.keyProvider.encrypt(`${transport}-pass`);
    await made.db.insert(mailboxCredentials).values({
      mailboxId, transport, secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "127.0.0.1", port, secure: false, user: "u@sink.example" },
    });
  }
  const [d] = await made.db.insert(drafts).values({
    accountId: s.accountId, mailboxId, subject: "Re: hi", body: "Thanks!",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
  } as never).returning();
  const row = async () => (await made.db.select().from(outboundSends).where(eq(outboundSends.draftId, d!.id)))[0]!;
  return { ...made, s, draftId: d!.id, row };
}
type World = Awaited<ReturnType<typeof world>>;

const press = (w: World, key: string): Promise<Response> =>
  H(req("POST", `/drafts/${w.draftId}/send`, { bearer: w.s.token, headers: { "idempotency-key": key } }), w.deps);

async function answer(res: Response) {
  const body = await res.json() as { status?: string; error?: { code?: string; retryable?: boolean } };
  return { status: res.status, wire: body.status ?? null, code: body.error?.code ?? null, retryable: body.error?.retryable ?? null, header: res.headers.get("retry-after") };
}

describe("the SMTP leg against a sink that fails once", () => {
  it("a 454 at AUTH is offered again and sends once", async () => {
    const smtp = await sink({ auth: (n) => (n === 1 ? "454 4.7.0 Temporary authentication failure" : undefined) });
    const w = await world(smtp.port);
    expect(await answer(await press(w, "k1"))).toEqual({ status: 424, wire: null, code: "send_busy", retryable: true, header: "2" });
    expect(await answer(await press(w, "k1"))).toMatchObject({ status: 200, wire: "sent" });
    expect(smtp.seen).toMatchObject({ auths: 2, datas: 1, messages: 1 });
    expect((await w.row()).attempts).toBe(2);
  });

  it("a 535 at AUTH is final: one AUTH, explicitly not retryable, and the replay is told it failed", async () => {
    const smtp = await sink({ auth: () => "535 5.7.8 authentication refused" });
    const w = await world(smtp.port);
    expect(await answer(await press(w, "k1"))).toEqual({ status: 424, wire: null, code: "send_login_refused", retryable: false, header: null });
    expect(await answer(await press(w, "k1"))).toMatchObject({ status: 409, wire: "failed" });
    expect(smtp.seen).toMatchObject({ connections: 1, auths: 1, datas: 0 });
  });

  it("a 450 at RCPT came before any data: offered again and sent once", async () => {
    const smtp = await sink({ rcpt: (n) => (n === 1 ? "450 4.2.1 mailbox busy" : undefined) });
    const w = await world(smtp.port);
    expect(await answer(await press(w, "k1"))).toEqual({ status: 424, wire: null, code: "send_busy", retryable: true, header: "2" });
    expect(await answer(await press(w, "k1"))).toMatchObject({ status: 200, wire: "sent" });
    expect(smtp.seen).toMatchObject({ rcpts: 2, datas: 1, messages: 1 });
  });
});

describe("at or after the envelope the fate stays unknown, whatever the server said", () => {
  const cases: Array<[string, Script]> = [
    ["the data taken and the connection dropped", { afterData: () => "drop" }],
    ["a 451 after DATA", { afterData: () => "451 4.3.0 try again later" }],
    ["a 554 after DATA", { afterData: () => "554 5.7.1 rejected" }],
  ];
  for (const [what, script] of cases) {
    it(`${what}: unverified, never failed, one DATA transaction at most, and the replay dials nothing`, async () => {
      const smtp = await sink(script);
      const w = await world(smtp.port);
      const first = await answer(await press(w, "k1"));
      expect(first.wire === "unverified" || first.wire === "queued", `answered ${JSON.stringify(first)}`).toBe(true);
      const row = await w.row();
      expect(["unverified", "pending"]).toContain(row.status);
      expect(row.retryUntil).toBeNull();
      const connections = smtp.seen.connections;
      const replay = await answer(await press(w, "k1"));
      expect(replay.wire).not.toBe("sent");
      expect(smtp.seen.connections, "the replay dialled the mail server again").toBe(connections);
      expect(smtp.seen.datas).toBeLessThanOrEqual(1);
    });
  }

  it("a close before the greeting released nothing: a dropped send, final, and the replay says so", async () => {
    const smtp = await sink({ closeBeforeGreeting: () => true });
    const w = await world(smtp.port);
    expect(await answer(await press(w, "k1"))).toEqual({ status: 424, wire: null, code: "send_upload_dropped", retryable: false, header: null });
    expect((await w.row()).status).toBe("failed");
    const connections = smtp.seen.connections;
    expect(await answer(await press(w, "k1"))).toMatchObject({ status: 424, code: "send_upload_dropped" });
    expect(smtp.seen.connections).toBe(connections);
  });
});
