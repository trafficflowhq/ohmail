import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { SmtpMailer } from "../src/index.js";
import type { InviteData } from "../src/mail/templates.js";

/**
 * ═══ SmtpMailer AGAINST A REAL (LOOPBACK) SMTP SERVER ═══════════════════════════════════════
 *
 * The sink below is a scriptable RFC 5321 party on 127.0.0.1 — a real socket, permitted by the
 * suite's network trap because loopback is not an egress. Scripting the OTHER side is the whole
 * point: greenmail/mailpit prove the accept path, but only a sink that can say `550` on RCPT can
 * decide the property this file exists for —
 *
 *   **`sent` MEANS THE SERVER ACCEPTED THE MESSAGE FOR THIS RECIPIENT, and nothing less.**
 *
 * That is not transport pedantry. `markInviteDelivered` (invites.ts) upgrades an invite row to
 * `confers_verified: true` exactly when the mailer answers `sent` — the claim "a mail carried
 * this code to the bound address". A mailer that answered `sent` on a refused RCPT would hand
 * receipt-proof to an inbox that never received anything, which re-opens the forged-verification
 * hole that column exists to close. Mutation: make `send` report `sent` unconditionally → the
 * refused-RCPT test goes red.
 */

const INVITE: InviteData = {
  code: "BETA-CODE-" + "1234",
  redeemUrl: "https://mail.example.com/join?code=BETA-CODE-" + "1234",
  expiresAt: "2026-09-01 12:00 UTC",
  supportEmail: "support@mail.example.com",
};

interface SinkScript {
  /** The reply to every RCPT TO. Default accepts. */
  rcpt?: string;
}

interface Sink {
  port: number;
  /** Complete DATA payloads, one per accepted message. */
  messages: string[];
  connections: number;
  close(): Promise<void>;
}

/** A minimal, scriptable SMTP server. Sequential (no PIPELINING advertised), cleartext. */
function smtpSink(script: SinkScript = {}): Promise<Sink> {
  const messages: string[] = [];
  const state = { connections: 0 };
  const server = net.createServer((socket) => {
    state.connections += 1;
    let buf = "";
    let inData = false;
    socket.write("220 sink ESMTP\r\n");
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push(buf.slice(0, end + 2));
          buf = buf.slice(end + 5);
          inData = false;
          socket.write("250 2.0.0 queued as SINK1\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const verb = line.split(/[\s:]/, 1)[0]!.toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250-sink\r\n250 8BITMIME\r\n");
        else if (verb === "MAIL") socket.write("250 2.1.0 ok\r\n");
        else if (verb === "RCPT") socket.write(`${script.rcpt ?? "250 2.1.5 ok"}\r\n`);
        else if (verb === "DATA") { inData = true; socket.write("354 go ahead\r\n"); }
        else if (verb === "RSET") socket.write("250 2.0.0 flushed\r\n");
        else if (verb === "QUIT") { socket.write("221 2.0.0 bye\r\n"); socket.end(); }
        else socket.write("500 5.5.1 what\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        messages,
        get connections() { return state.connections; },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const open: Sink[] = [];
async function sink(script: SinkScript = {}): Promise<Sink> {
  const s = await smtpSink(script);
  open.push(s);
  return s;
}
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

const mailerFor = (port: number, over: { url?: string; replyTo?: string } = {}): SmtpMailer =>
  new SmtpMailer({
    url: over.url ?? `smtp://127.0.0.1:${port}`,
    from: "ohmail <no-reply@mail.example.com>",
    replyTo: over.replyTo,
  });

describe("the accept path — a rendered template arrives on the wire", () => {
  it("answers sent, and the DATA the server took is the rendered invite with our headers", async () => {
    const s = await sink();
    const result = await mailerFor(s.port, { replyTo: "owner@mail.example.com" })
      .send("member@family.example", "invite", INVITE);

    expect(result.status).toBe("sent");
    // The correlation id is nodemailer's Message-ID — OURS, minted locally. SMTP has no
    // provider-assigned id in the reply worth parsing; null would also be honest, but the
    // Message-ID is what a maildir search can actually find.
    expect(result).toMatchObject({ providerId: expect.stringContaining("@") });

    expect(s.messages).toHaveLength(1);
    const data = s.messages[0]!;
    expect(data).toContain("Subject: Your ohmail beta invite");
    expect(data).toContain("BETA-CODE-" + "1234");
    expect(data).toContain("From: ohmail <no-reply@mail.example.com>");
    expect(data).toContain("To: member@family.example");
    expect(data).toContain("Reply-To: owner@mail.example.com");
  });

  it("a template's own reply address wins over the configured one", async () => {
    const s = await sink();
    await mailerFor(s.port, { replyTo: "owner@mail.example.com" }).send("member@family.example", "lifecycle_notice", {
      kind: "trial_two_days", locale: "en", anchorDate: "26 October 2026, 18:05 UTC", erasureDate: null,
      accountUrl: "https://ohmail.app/#/settings/account", setupUrl: "https://ohmail.app/#/first-run/again",
      noMailbox: true, supportEmail: "support@ohmail.app",
    });
    expect(s.messages[0]).toContain("Reply-To: support@ohmail.app");
  });
});

describe("`sent` is TRANSPORT ACCEPTANCE, never optimism — the confers-verified coupling", () => {
  it("a permanently refused RCPT (550) is failed and NOT retryable — and above all NOT sent", async () => {
    const s = await sink({ rcpt: "550 5.1.1 no such user" });
    const result = await mailerFor(s.port).send("member@family.example", "invite", INVITE);
    // `markInviteDelivered` keys `confers_verified` on `sent`. This is the assertion that keeps
    // a refused recipient from being stamped receipt-proof.
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ retryable: false });
    expect(s.messages).toHaveLength(0);
  });

  it("a transiently refused RCPT (450) is failed and retryable — SMTP 4xx is 'later', not 'never'", async () => {
    const s = await sink({ rcpt: "450 4.2.1 greylisted, come back" });
    const result = await mailerFor(s.port).send("member@family.example", "invite", INVITE);
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ retryable: true });
  });

  it("a dead server is failed-retryable, and send NEVER throws", async () => {
    const s = await sink();
    const port = s.port;
    await s.close();
    open.pop();
    const result = await mailerFor(port).send("member@family.example", "invite", INVITE);
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ retryable: true });
  });
});

describe("recipients and secrets", () => {
  it("an impossible recipient is skipped without ever opening a socket", async () => {
    const s = await sink();
    const result = await mailerFor(s.port).send("not an address", "invite", INVITE);
    expect(result).toEqual({ status: "skipped", reason: "invalid_recipient" });
    expect(s.connections).toBe(0);
  });

  it("no error string ever carries the SMTP password or an address", async () => {
    /* The userinfo is interpolated: the push gate reads `user:pw@127.0.0.1:${port}` as a real host. */
    const user = "mailer";
    const secret = "sekretpass";
    const s = await sink({ rcpt: "550 5.1.1 gone" });
    const refused = await new SmtpMailer({
      url: `smtp://${user}:${secret}@127.0.0.1:${s.port}`,
      from: "no-reply@mail.example.com",
    }).send("member@family.example", "invite", INVITE);
    const dead = await new SmtpMailer({
      url: `smtp://${user}:${secret}@127.0.0.1:1`,
      from: "no-reply@mail.example.com",
    }).send("member@family.example", "invite", INVITE);
    for (const r of [refused, dead]) {
      expect(r.status).toBe("failed");
      const err = (r as { error: string }).error;
      expect(err).not.toContain(secret);
      expect(err).not.toContain("member@family.example");
    }
  });
});

describe("construction refusals — fixed sentences, no values echoed", () => {
  it("refuses a non-loopback SMTP host under a test runner (the zero-external-requests rule)", () => {
    expect(() => new SmtpMailer({ url: "smtp://mail.example.com:587", from: "a@b.example" }))
      .toThrow(/loopback/);
  });

  it("refuses a scheme that is not smtp(s) and a from that could inject headers", () => {
    expect(() => new SmtpMailer({ url: "http://127.0.0.1:2525", from: "a@b.example" }))
      .toThrow(/smtp/);
    expect(() => new SmtpMailer({ url: "smtp://127.0.0.1:2525", from: "a@b.example\r\nBcc: x@y.example" }))
      .toThrow(/control character/);
  });
});

/**
 * REVIEW FIXES, each shown red against the unfixed code: the loopback predicate must not be
 * spoofable by a DNS NAME that merely starts with "127." (that spelling bypassed both the
 * test-runner egress refusal and the requireTLS arming); a URL with no host must refuse rather
 * than letting the transport default to localhost (a misdirected relay, not a boot refusal);
 * and an IPv6 literal must reach the transport UNBRACKETED or every send dies in DNS.
 */
describe("review hardening — loopback is an ADDRESS, never a name shape", () => {
  it("a DNS name starting with 127. is NOT loopback — refused under the test runner like any remote host", () => {
    expect(() => new SmtpMailer({ url: "smtp://user:pw@127.smtp.vendor.example:587", from: "a@b.example" }))
      .toThrow(/loopback/);
  });

  it("a URL with no host refuses construction — nodemailer would silently default it to localhost", () => {
    // The regex is the SPECIFIC refusal, not any sentence containing "host": under vitest the
    // loopback guard also fires on an empty hostname, which made a laxer assertion pass against
    // the unfixed code — while production (no test runner) would have relayed through localhost.
    expect(() => new SmtpMailer({ url: "smtp:///", from: "a@b.example" }))
      .toThrow(/must name a host/);
  });

  it("an IPv6 loopback literal is accepted AND handed to the transport unbracketed", () => {
    const mailer = new SmtpMailer({ url: "smtp://[::1]:2525", from: "a@b.example" });
    // The transport's own option is the observable: node's dialer takes `::1`, not `[::1]`
    // (the bracketed form is URL syntax, and passing it through fails every send in DNS).
    const host = (mailer as unknown as { transporter: { options: { host: string } } }).transporter.options.host;
    expect(host).toBe("::1");
  });
});
