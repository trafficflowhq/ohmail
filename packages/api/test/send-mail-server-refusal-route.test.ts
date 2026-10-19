import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { drafts, mailboxCredentials, outboundSends } from "@trafficflow/db";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { SendConnections, type KeepTimers, type OpenSendAdapter } from "@trafficflow/core/mail";
import { ServiceError, type HostResolver } from "@trafficflow/services/mail";
import { makeSendAdapter } from "../src/send-adapter.js";
import { makeProbeHostGuard } from "../src/imap-probe.js";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";

/**
 * A REFUSAL THE PERSON'S MAIL SERVER MADE IS NOT OUR 5XX. Through the real route, the production
 * `makeSendAdapter` and real sockets: a refusal the server made answers as a refusal, with its own code, and
 * writes no fault row; a code shipped clients retry on its 502 keeps the 502 and writes no fault
 * row. Controls: our own TypeError still answers 500 and is counted, an SMTP 550 for the
 * recipient still answers `unverified`, and an unmarked 502 of ours is still counted.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const timers: KeepTimers = { set: () => 0, clear: () => undefined };
const open: net.Server[] = [];
const sockets: net.Socket[] = [];
// Short, and in production's order: the greeting deadline fires before the socket's idle one.
const SHORT = { connectionMs: 600, greetingMs: 600, socketMs: 1_500 };

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

/** Line-at-a-time server: `answer` gets each command line and writes what the server says. */
function lineServer(greeting: string, answer: (line: string, sock: net.Socket) => void): Promise<number> {
  return listen(net.createServer((sock) => {
    sock.write(greeting);
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        answer(line, sock);
      }
    });
  }));
}

/** An IMAP server that refuses the LOGIN the way a wrong password is refused. */
const imapRefusingLogin = (): Promise<number> => lineServer("* OK [CAPABILITY IMAP4rev1] ready\r\n", (line, sock) => {
  const [tag, cmd] = line.split(" ");
  const c = (cmd ?? "").toUpperCase();
  if (c === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
  else if (c === "LOGIN") sock.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
  else sock.write(`${tag} BAD unknown\r\n`);
});

/** A plaintext IMAP server: dialled with TLS it is a handshake the server cannot complete. */
const imapPlaintext = (): Promise<number> => lineServer("* OK ready\r\n", (line, sock) => {
  sock.write(`${line.split(" ")[0]} BAD unknown\r\n`);
});

/** A submission server; `on` answers STARTTLS, AUTH and the end of DATA, the rest is scripted. */
function smtpServer(
  on: { starttls?: string; auth?: string; rcpt?: string; afterData?: (sock: net.Socket) => void },
): Promise<number> {
  let inData = false;
  return lineServer("220 fake ESMTP\r\n", (raw, sock) => {
    if (inData) {
      if (raw === ".") { inData = false; on.afterData ? on.afterData(sock) : sock.write("250 ok\r\n"); }
      return;
    }
    const line = raw.toUpperCase();
    if (line.startsWith("EHLO")) sock.write(`250-fake\r\n${on.starttls ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN LOGIN\r\n`);
    else if (line.startsWith("STARTTLS")) sock.write(on.starttls ?? "454 no\r\n");
    else if (line.startsWith("AUTH")) sock.write(on.auth ?? "235 2.7.0 ok\r\n");
    else if (line.startsWith("RCPT TO")) sock.write(on.rcpt ?? "250 ok\r\n");
    else if (line.startsWith("DATA")) { inData = true; sock.write("354 go\r\n"); }
    else if (line.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
    else sock.write("250 ok\r\n");
  });
}

/** The IMAP leg as a double, so the SMTP leg is the one that meets the server. */
function fakeImap(search: () => Promise<number[]> = async () => []) {
  return {
    list: async () => [
      { path: "INBOX", delimiter: "/", flags: new Set<string>() },
      { path: "Sent", delimiter: "/", flags: new Set<string>(), specialUse: "\\Sent" },
    ],
    on: () => undefined,
    logout: async () => undefined,
    close: () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    search,
  };
}

type Factory = (deps: () => ApiDeps) => OpenSendAdapter;

/** The production factory with short deadlines, and optionally a doubled IMAP client. */
const production = (imap?: ReturnType<typeof fakeImap>): Factory => (deps) => (id: string) =>
  makeSendAdapter(deps(), id, { timeouts: SHORT },
    imap ? (cfg: ImapConfig) => new ImapAdapter(cfg, { client: imap as never }) : undefined,
    new SendConnections({ timers }));

async function world(factory: Factory = production(), hostedResolver?: HostResolver) {
  let ref: ApiDeps | null = null;
  const made = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory(() => ref!) });
  // `makeDeps` stubs the IMAP dial for every other route test; this file is about the dial.
  vi.restoreAllMocks();
  ref = made.deps;
  if (hostedResolver) {
    (made.deps.services as unknown as { probeHostGuard: unknown }).probeHostGuard = makeProbeHostGuard(hostedResolver);
  }
  const faults: Array<{ status: number; errorClass: string }> = [];
  made.deps.faultLog = { record: async (f) => { faults.push({ status: f.status, errorClass: f.errorClass }); } };
  const s = await seedSession(made.db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(made.db, { accountId: s.accountId, address: "u@refusal.example" });
  const [d] = await made.db.insert(drafts).values({
    accountId: s.accountId, mailboxId, subject: "Re: hi", body: "Thanks!",
    to: [{ name: null, address: "you@example.com" }], status: "draft",
  } as never).returning();
  return { ...made, s, mailboxId, draftId: d!.id, faults };
}

type World = Awaited<ReturnType<typeof world>>;

async function credentials(
  w: World, imap: { port: number; secure?: boolean; host?: string; smtpUnsettled?: string }, smtpPort: number | null,
): Promise<void> {
  const rows: Array<["imap" | "smtp", Record<string, unknown>]> = [["imap", {
    host: imap.host ?? "127.0.0.1", port: imap.port, secure: imap.secure ?? false, user: "u@refusal.example",
    ...(imap.smtpUnsettled ? { smtpUnsettled: imap.smtpUnsettled } : {}),
  }]];
  if (smtpPort !== null) rows.push(["smtp", { host: "127.0.0.1", port: smtpPort, secure: false, user: "u@refusal.example" }]);
  for (const [transport, meta] of rows) {
    const enc = await w.deps.keyProvider.encrypt(`${transport}-pass`);
    await w.db.insert(mailboxCredentials).values({
      mailboxId: w.mailboxId, transport, secretEnc: enc.ciphertext, keyVersion: enc.keyVersion, meta,
    });
  }
}

const press = (w: World, key: string): Promise<Response> =>
  H(req("POST", `/drafts/${w.draftId}/send`, { bearer: w.s.token, headers: { "idempotency-key": key } }), w.deps);

async function answer(res: Response): Promise<{ status: number; code?: string; retryable?: boolean; message?: string; body: unknown }> {
  const body = await res.json() as { error?: { code?: string; retryable?: boolean; message?: string } };
  return { status: res.status, code: body.error?.code, retryable: body.error?.retryable, message: body.error?.message, body };
}

/**
 * A refusal the mail server made: 424 with its code, nothing offered, the draft kept, no fault row.
 * `retryable` is whether a short wait may cure it: an unreachable server is offered again under the
 * key, a refused sign-in or an unsecured connection is final.
 */
async function assertRefusedAt424(w: World, res: Response, code: string, sentence: RegExp, retryable = false): Promise<void> {
  const a = await answer(res);
  // ONE assertion, so a red names the old status AND the fault row it wrote.
  expect({ status: a.status, code: a.code, retryable: a.retryable, faults: w.faults.map((f) => f.status) })
    .toEqual({ status: 424, code, retryable, faults: [] });
  expect(a.message).toMatch(sentence);
  const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
  expect(row!.status).toBe("failed");
  const [d] = await w.db.select().from(drafts).where(eq(drafts.id, w.draftId));
  expect({ status: d!.status, sendKey: d!.sendKey }).toEqual({ status: "draft", sendKey: null });
  expect(w.faults, "a refusal the person's mail server made was counted as our fault").toEqual([]);
}

describe("POST /drafts/:id/send — a refusal the mail server made answers 424", () => {
  it("SMTP: STARTTLS refused answers send_not_secured at 424", async () => {
    const w = await world(production(fakeImap()));
    await credentials(w, { port: await closedPort() }, await smtpServer({ starttls: "454 TLS not available\r\n" }));
    await assertRefusedAt424(w, await press(w, "tls-1"), "send_not_secured", /could not be secured/);
  });

  it("SMTP: the login refused answers send_login_refused at 424", async () => {
    const w = await world(production(fakeImap()));
    await credentials(w, { port: await closedPort() }, await smtpServer({ auth: "535 5.7.8 bad credentials\r\n" }));
    await assertRefusedAt424(w, await press(w, "auth-1"), "send_login_refused", /refused the sign-in/);
  });

  it("SMTP: a refused DIAL is send_unreachable at 424, offered again, never unverified", async () => {
    const w = await world(production(fakeImap()));
    await credentials(w, { port: await closedPort() }, await closedPort());
    await assertRefusedAt424(w, await press(w, "smtp-dial-1"), "send_unreachable", /could not be reached/, true);
  });

  it("SMTP: a submission server that never greets is send_unreachable at 424, offered again, never unverified", async () => {
    const w = await world(production(fakeImap()));
    await credentials(w, { port: await closedPort() }, await listen(net.createServer(() => { /* silent */ })));
    await assertRefusedAt424(w, await press(w, "smtp-silent-1"), "send_unreachable", /could not be reached/, true);
  });

  it("IMAP: the LOGIN refused at the dial answers send_login_refused at 424, not 500", async () => {
    const w = await world();
    await credentials(w, { port: await imapRefusingLogin() }, await closedPort());
    await assertRefusedAt424(w, await press(w, "imap-auth-1"), "send_login_refused", /refused the sign-in/);
  });

  it("IMAP: a TLS handshake that fails at the dial answers send_not_secured at 424, not 500", async () => {
    const w = await world();
    await credentials(w, { port: await imapPlaintext(), secure: true }, await closedPort());
    await assertRefusedAt424(w, await press(w, "imap-tls-1"), "send_not_secured", /could not be secured/);
  });
});

describe("POST /drafts/:id/send — the Sent check fails after an ambiguous SMTP error", () => {
  it("answers queued at 202 with the reservation pending, not a 500", async () => {
    const dead = async (): Promise<never> => { throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }); };
    const w = await world(production(fakeImap(dead)));
    await credentials(w, { port: await closedPort() }, await smtpServer({ afterData: () => { /* never answers the dot */ } }));
    const res = await press(w, "probe-dead-1");
    expect({ status: res.status, faults: w.faults.map((f) => f.status) }).toEqual({ status: 202, faults: [] });
    expect((await res.json() as { status?: string }).status).toBe("queued");
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status, "the fate is unknown: the reservation stays for verify-by-Sent").toBe("pending");
    expect(w.faults).toEqual([]);
  });

  it("CONTROL: a probe fault of OURS keeps its 500 and is counted", async () => {
    const ours = async (): Promise<never> => { throw new TypeError("cannot read properties of undefined"); };
    const w = await world(production(fakeImap(ours)));
    await credentials(w, { port: await closedPort() }, await smtpServer({ afterData: () => { /* never answers the dot */ } }));
    const res = await press(w, "probe-ours-1");
    expect(res.status).toBe(500);
    expect(w.faults.map((f) => f.status)).toEqual([500]);
  });
});

describe("POST /drafts/:id/send — a 502 shipped clients retry keeps its status and writes no fault row", () => {
  it("smtp_not_settled: 502, explicitly not retryable (the key is spent), no fault row", async () => {
    const w = await world();
    await credentials(w, { port: await closedPort(), smtpUnsettled: "connect" }, null);
    const a = await answer(await press(w, "unsettled-1"));
    expect({ status: a.status, code: a.code, retryable: a.retryable, faults: w.faults.map((f) => f.status) })
      .toEqual({ status: 502, code: "smtp_not_settled", retryable: false, faults: [] });
  });

  it("mailbox_host_refused: 502, no fault row", async () => {
    const resolver: HostResolver = { resolve: async () => ["169.254.169.254"] };
    const w = await world(production(), resolver);
    await credentials(w, { port: 993, host: "imap.rebound.example" }, null);
    const a = await answer(await press(w, "host-1"));
    expect({ status: a.status, code: a.code, faults: w.faults.map((f) => f.status) })
      .toEqual({ status: 502, code: "mailbox_host_refused", faults: [] });
  });

  it("no IMAP credential on this host: 424 mailbox_not_signed_in, not retryable, ended at the first attempt", async () => {
    // The reservation is finalized `failed` before the refusal leaves, so the key is spent: a 502
    // the client retried met 409 `failed` under "still trying". Consumer: the send client, which
    // reads `retryable: false` as terminal and shows the sentence.
    const w = await world();
    await assertRefusedAt424(w, await press(w, "nocred-1"), "mailbox_not_signed_in", /not signed in here/);
  });

  it("CONTROL: an unmarked 502 of ours is still counted", async () => {
    const w = await world(() => async () => { throw new ServiceError("upstream_unavailable", 502, "ours"); });
    const a = await answer(await press(w, "plain-502"));
    expect(a.status).toBe(502);
    expect(w.faults.map((f) => f.status)).toEqual([502]);
  });
});

describe("CONTROLS on the same route", () => {
  it("a TypeError of ours in the window answers 500 and is counted", async () => {
    const w = await world(() => async () => { throw new TypeError("cannot read properties of undefined"); });
    const a = await answer(await press(w, "ours-1"));
    expect({ status: a.status, code: a.code }).toEqual({ status: 500, code: "internal" });
    expect(w.faults.map((f) => f.status)).toEqual([500]);
  });

  it("an SMTP 550 for the recipient keeps unverified", async () => {
    const w = await world(production(fakeImap()));
    await credentials(w, { port: await closedPort() }, await smtpServer({ rcpt: "550 5.1.1 no such user\r\n" }));
    const res = await press(w, "rcpt-550");
    expect(res.status).toBe(200);
    expect((await res.json() as { status?: string }).status).toBe("unverified");
    expect(w.faults).toEqual([]);
  });
});
