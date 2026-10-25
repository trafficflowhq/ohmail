import net from "node:net";
import { Duplex } from "node:stream";
import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../src/adapters/imap.js";
import { SendNotSubmitted, SentCopyAppendFailed, submissionNeverOffered } from "../src/send.js";

/**
 * A SUBMISSION THAT NEVER GOT PAST SECURING OR LOGIN IS A DEFINITE NON-DELIVERY.
 *
 * nodemailer raises `ETLS` only while STARTTLS is asked for or the upgrade runs, and `EAUTH` only
 * during login; the phone's transport stamps `tlsFailed` on an error before its handshake is
 * confirmed. Each of those proves no envelope was offered, so `ImapAdapter.send` says so by type.
 * Before, every one of them read as an ambiguous SMTP throw and the send ended "couldn't confirm".
 * A timeout, a reset or a close proves nothing about the envelope and stays ambiguous.
 */

const fail = (code: string | undefined, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("smtp"), code ? { code } : {}, extra);

describe("which submission errors prove nothing was offered", () => {
  it("names the step for the three that do", () => {
    expect(submissionNeverOffered(fail("ETLS"))).toBe("secure");
    expect(submissionNeverOffered(fail("ESOCKET", { tlsFailed: true }))).toBe("secure");
    expect(submissionNeverOffered(fail("EAUTH"))).toBe("login");
  });

  it("proves nothing for everything else", () => {
    for (const code of ["ETIMEDOUT", "ECONNECTION", "ESOCKET", "EENVELOPE", "EMESSAGE", undefined]) {
      expect(submissionNeverOffered(fail(code))).toBeNull();
    }
    expect(submissionNeverOffered(null)).toBeNull();
    expect(submissionNeverOffered("ETLS")).toBeNull();
  });
});

describe("ImapAdapter.send over a submission that never offered the message", () => {
  const adapterFailing = (err: Error) => {
    const adapter = new ImapAdapter({
      host: "example.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" },
      smtp: { host: "example.invalid", port: 587, secure: false, auth: { user: "u", pass: "p" } },
    });
    (adapter as unknown as { transporter: unknown }).transporter = {
      sendMail: async () => { throw err; }, close() { /* nothing */ },
    };
    return adapter;
  };
  const send = (a: ImapAdapter) =>
    a.send({ from: "u@example.test", to: "b@example.test", subject: "s", text: "t" }).then(() => "resolved", (e: unknown) => e);

  it("throws SendNotSubmitted with the step, carrying the client's own error", async () => {
    const tlsErr = fail("ETLS");
    const secured = await send(adapterFailing(tlsErr));
    expect(secured).toBeInstanceOf(SendNotSubmitted);
    expect((secured as SendNotSubmitted).step).toBe("secure");
    expect((secured as { cause?: unknown }).cause).toBe(tlsErr);
    // Every reader that classifies by code or message reads what it read before the wrap.
    expect((secured as SendNotSubmitted).code).toBe("ETLS");
    expect((secured as Error).message).toBe(tlsErr.message);

    const login = await send(adapterFailing(fail("EAUTH")));
    expect(login).toBeInstanceOf(SendNotSubmitted);
    expect((login as SendNotSubmitted).step).toBe("login");
  });

  it("a transporter without the release gate proves nothing: its timeout reaches the caller unchanged", async () => {
    const timeout = fail("ETIMEDOUT");
    const out = await send(adapterFailing(timeout));
    expect(out).toBe(timeout);
    expect(out).not.toBeInstanceOf(SendNotSubmitted);
    expect(out).not.toBeInstanceOf(SentCopyAppendFailed);
  });
});

/**
 * THE END OF THE MESSAGE IS RELEASED ONLY AFTER `beforeRelease`, over real sockets and the pinned
 * nodemailer: a session that ends before the release delivered nothing (`data`), and the server
 * never saw the end-of-data mark; after the release an error stays ambiguous.
 */
describe("a submission that ends before its end-of-data mark is `data`", () => {
  type Mode = "ok" | "drop-mid-upload" | "rcpt-550" | "close-after-mark" | "silent-after-mark";
  const PHOTO = Buffer.alloc(300 * 1024, 7);
  const servers: Array<{ close(): void }> = [];

  async function smtp(mode: Mode, dropAt = 100_000) {
    const seen = { dataBytes: 0, mark: false, onMark: undefined as (() => void) | undefined };
    const server = net.createServer((s) => {
      s.on("error", () => undefined);
      s.write("220 fake ESMTP\r\n");
      let inData = false;
      let buf = "";
      s.on("data", (d: Buffer) => {
        if (inData) {
          seen.dataBytes += d.length;
          buf = (buf + d.toString("latin1")).slice(-16);
          if (mode === "drop-mid-upload" && seen.dataBytes > dropAt) { s.destroy(); return; }
          if (buf.endsWith("\r\n.\r\n")) {
            seen.mark = true;
            seen.onMark?.();
            inData = false;
            if (mode === "close-after-mark") s.destroy();
            else if (mode === "ok") s.write("250 queued\r\n");
          }
          return;
        }
        buf += d.toString("latin1");
        let i: number;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^EHLO/i.test(line)) s.write("250-fake\r\n250 AUTH PLAIN\r\n");
          else if (/^AUTH/i.test(line)) s.write("235 ok\r\n");
          else if (/^RCPT/i.test(line) && mode === "rcpt-550") s.write("550 5.1.1 no such user\r\n");
          else if (/^DATA/i.test(line)) { s.write("354 go\r\n"); inData = true; buf = ""; return; }
          else if (/^QUIT/i.test(line)) { s.write("221 bye\r\n"); s.end(); }
          else s.write("250 ok\r\n");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    servers.push({ close: () => server.close() });
    return { port: (server.address() as { port: number }).port, seen };
  }

  async function adapterOn(port: number) {
    const fakeImap = {
      list: async () => [{ path: "INBOX", delimiter: "/", flags: new Set<string>() }],
      on: () => undefined, logout: async () => undefined, close: () => undefined,
    };
    const a = new ImapAdapter({
      host: "127.0.0.1", port: 1, secure: false, auth: { user: "u", pass: "p" },
      smtp: { host: "127.0.0.1", port, secure: false, allowInsecure: true, auth: { user: "u", pass: "p" } },
      timeouts: { connectionMs: 2_000, greetingMs: 2_000, socketMs: 1_000 },
    } as never, { client: fakeImap as never });
    await a.connect();
    return a;
  }

  const MSG = {
    from: "u@example.test", to: "b@example.test", subject: "the photo", text: "A photo letter.",
    attachments: [{ filename: "p.jpg", contentType: "image/jpeg", content: PHOTO }],
  };
  const sendWith = (a: ImapAdapter, beforeRelease: () => Promise<void>) =>
    a.send(MSG, { copy: "caller", beforeRelease }).then((r) => r, (e: unknown) => e);

  it("a server that drops the connection mid-upload: SendNotSubmitted('data'), no mark, no release", async () => {
    const { port, seen } = await smtp("drop-mid-upload");
    let released = 0;
    const out = await sendWith(await adapterOn(port), async () => { released += 1; });
    expect(out).toBeInstanceOf(SendNotSubmitted);
    expect((out as SendNotSubmitted).step).toBe("data");
    expect(seen.dataBytes).toBeGreaterThan(0);
    expect(seen.mark).toBe(false);
    expect(released).toBe(0);
  }, 15_000);

  /** The SMTP socket as a slow link: bytes wait in its own write queue and leave at `rate` per second. */
  function overSlowLink(a: ImapAdapter, port: number, rate: number): void {
    (a as unknown as { transporter: { getSocket: unknown } }).transporter.getSocket = (
      _o: unknown, cb: (e: Error | null, s?: { connection: Duplex }) => void,
    ) => {
      const sock = net.connect(port, "127.0.0.1", () => cb(null, { connection: link }));
      const link = new Duplex({
        write(chunk: Buffer, _e, done) {
          setTimeout(() => { if (!sock.destroyed) sock.write(chunk); done(); }, (chunk.length / rate) * 1000);
        },
        read() { /* pushed from the socket */ },
      });
      Object.assign(link, { setTimeout: () => link, setKeepAlive: () => link });
      sock.on("data", (d: Buffer) => link.push(d));
      sock.on("error", () => undefined);
      sock.on("close", () => link.destroy());
    };
  }

  it("a slow link dropped half-way through the photo: `data`, no release, no mark (the gate waits for the socket)", async () => {
    const { port, seen } = await smtp("drop-mid-upload", 200_000);
    const a = await adapterOn(port);
    overSlowLink(a, port, 2_000_000);
    let released = 0;
    const out = await sendWith(a, async () => { released += 1; });
    expect(out).toBeInstanceOf(SendNotSubmitted);
    expect((out as SendNotSubmitted).step).toBe("data");
    expect({ released, mark: seen.mark }).toEqual({ released: 0, mark: false });
  }, 15_000);

  it("a refused release: SendNotSubmitted('data'), and the server never sees the end of the message", async () => {
    const { port, seen } = await smtp("ok");
    const out = await sendWith(await adapterOn(port), async () => { throw new Error("the row is no longer this attempt's"); });
    expect(out).toBeInstanceOf(SendNotSubmitted);
    expect((out as SendNotSubmitted).step).toBe("data");
    expect(seen.dataBytes).toBeGreaterThan(0);
    expect(seen.mark).toBe(false);
  }, 15_000);

  it("a 550 to RCPT is `data` with the server's code: final, nothing was accepted", async () => {
    const { port, seen } = await smtp("rcpt-550");
    let released = 0;
    const out = await sendWith(await adapterOn(port), async () => { released += 1; });
    expect(out).toBeInstanceOf(SendNotSubmitted);
    expect((out as SendNotSubmitted).step).toBe("data");
    expect((out as SendNotSubmitted).responseCode).toBe(550);
    await new Promise((r) => { setTimeout(r, 50); });
    expect({ dataBytes: seen.dataBytes, released }).toEqual({ dataBytes: 0, released: 0 });
  }, 15_000);

  it("the normal path: the mark follows the release, and `caller` hands back the copy's bytes", async () => {
    const { port, seen } = await smtp("ok");
    const order: string[] = [];
    const out = await sendWith(await adapterOn(port), async () => { order.push(seen.mark ? "after-mark" : "before-mark"); });
    expect(out).not.toBeInstanceOf(Error);
    expect(order).toEqual(["before-mark"]);
    expect(seen.mark).toBe(true);
    const res = out as { sentLocator: unknown; unfiledCopy?: Buffer };
    expect(res.sentLocator).toBeNull();
    expect(res.unfiledCopy?.toString("latin1")).toContain("Subject: the photo");
  }, 15_000);

  it("CONTROL: the server read the end of the message and closed without a 250 — ambiguous", async () => {
    const { port, seen } = await smtp("close-after-mark");
    const out = await sendWith(await adapterOn(port), async () => undefined);
    expect(seen.mark).toBe(true);
    expect(out).toBeInstanceOf(Error);
    expect(out).not.toBeInstanceOf(SendNotSubmitted);
  }, 15_000);

  it("a stop after the release ends the session at once; the outcome stays ambiguous", async () => {
    const { port, seen } = await smtp("silent-after-mark");
    const stop = new AbortController();
    // Stopped when the server reads the mark: Nagle may hold those 3 bytes for a delayed ACK (40 ms).
    seen.onMark = () => stop.abort();
    const out = await (await adapterOn(port)).send(MSG, { copy: "caller", signal: stop.signal })
      .then((r) => r, (e: unknown) => e);
    expect(seen.mark).toBe(true);
    expect(out).toBeInstanceOf(Error);
    expect(out).not.toBeInstanceOf(SendNotSubmitted);
    expect((out as { code?: string }).code, "not the socket deadline's own timeout").not.toBe("ETIMEDOUT");
  }, 15_000);

  it("CONTROL: a timeout after the release reaches the caller unchanged", async () => {
    const { port, seen } = await smtp("silent-after-mark");
    const out = await sendWith(await adapterOn(port), async () => undefined);
    expect(seen.mark).toBe(true);
    expect((out as { code?: string }).code).toBe("ETIMEDOUT");
    expect(out).not.toBeInstanceOf(SendNotSubmitted);
    expect(out).not.toBeInstanceOf(SentCopyAppendFailed);
    for (const srv of servers.splice(0)) srv.close();
  }, 15_000);
});

describe("a submission whose socket never connected is `connect`", () => {
  it("reads DNS, the socket's own connect and the two deadlines before the greeting", () => {
    expect(submissionNeverOffered(fail("EDNS", { syscall: "getaddrinfo" }))).toBe("connect");
    expect(submissionNeverOffered(fail("ESOCKET", { syscall: "connect" }))).toBe("connect");
    expect(submissionNeverOffered(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }))).toBe("connect");
    expect(submissionNeverOffered(Object.assign(new Error("Greeting never received"), { code: "ETIMEDOUT" }))).toBe("connect");
  });

  it("CONTROL: a socket error or a timeout after the greeting proves nothing", () => {
    expect(submissionNeverOffered(fail("ESOCKET", { syscall: "read" }))).toBeNull();
    expect(submissionNeverOffered(Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" }))).toBeNull();
    expect(submissionNeverOffered(Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" }))).toBeNull();
  });

  /* Over real sockets and the pinned nodemailer: the strings and fields the arm reads are its own. */
  const realSend = async (port: number) => {
    const fakeImap = {
      list: async () => [{ path: "INBOX", delimiter: "/", flags: new Set<string>() }],
      on: () => undefined, logout: async () => undefined, close: () => undefined,
    };
    const a = new ImapAdapter({
      host: "127.0.0.1", port: 1, secure: false, auth: { user: "u", pass: "p" },
      smtp: { host: "127.0.0.1", port, secure: false, auth: { user: "u", pass: "p" } },
      timeouts: { connectionMs: 500, greetingMs: 500, socketMs: 2_000 },
    }, { client: fakeImap as never });
    await a.connect();
    return a.send({ from: "u@example.test", to: "b@example.test", subject: "s", text: "t" })
      .then(() => "resolved", (e: unknown) => e);
  };

  it("a refused port and a server that never greets both throw SendNotSubmitted('connect')", async () => {
    const net = await import("node:net");
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const refused = await realSend(closedPort);
    expect(refused).toBeInstanceOf(SendNotSubmitted);
    expect((refused as SendNotSubmitted).step).toBe("connect");

    const held: import("node:net").Socket[] = [];
    const silent = net.createServer((s) => { held.push(s); });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    try {
      const unanswered = await realSend((silent.address() as { port: number }).port);
      expect(unanswered).toBeInstanceOf(SendNotSubmitted);
      expect((unanswered as SendNotSubmitted).step).toBe("connect");
    } finally {
      for (const s of held) s.destroy();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });
});
