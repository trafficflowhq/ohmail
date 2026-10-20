import net from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { ImapAdapter, imapFlowOptions, smtpTransportOptions } from "../../src/adapters/imap.js";
import {
  loopbackHarnessReason, imapTlsFloor, smtpTlsFloor, TLS_FLOOR, type ImapConfig,
} from "../../src/adapters/imap-types.js";
import { isLocalServerHost } from "../../../../apps/webapp/app/shell/local-server-host.js";
import { LOOPBACK_ADMITTED, LOOPBACK_LOOKALIKES } from "./_loopback-table.js";

/**
 * the TLS floor on the ohmail→provider leg.
 *
 * ── WHAT THESE TESTS ASSERT, AND WHY IT IS NOT THE OBVIOUS THING ───────────────────────
 *
 * `expect(cfg.secure).toBe(true)` proves nothing about what crossed the socket. So the
 * load-bearing tests here run a REAL fake IMAP/SMTP server, record every line it received,
 * and assert on the TRANSCRIPT: that no `LOGIN` and no `AUTH` ever arrived when the
 * connection failed to become encrypted. Remove the floor and the transcript contains the
 * user's password in clear text, which is exactly the failure this floor names.
 *
 * ── `0.0.0.0`, AND WHY IT IS LOAD-BEARING RATHER THAN CUTE ─────────────────────────────
 *
 * The exemption is keyed on the host being loopback, which at first looks like it makes the
 * two things a wire test needs mutually exclusive: a host the floor ENFORCES is by
 * definition off-machine and has nowhere local to listen, and any host with a local
 * listener is exempt. `0.0.0.0` is the one address that is both — `loopbackHarnessReason`
 * returns null for it (asserted below, in the lookalike table), and a `connect()` to it
 * reaches a listener bound on `127.0.0.1`. Verified on darwin 24.6 and on Linux
 * (`node:22-alpine`), which is what CI runs.
 *
 * That is what lets every wire test below go through the REAL `ImapAdapter.connect()` and
 * `ImapAdapter.send()` rather than through a hand-assembled option set. It matters: the
 * first version of this file built the client from `imapFlowOptions()` directly, and
 * reverting `connect()` to its pre-B7 inline options — the single likeliest regression —
 * left all eleven tests GREEN.
 */

// ─── fake servers ────────────────────────────────────────────────────────────────────────

interface Fake { port: number; lines: string[]; close: () => Promise<void> }

/** The reply to the first bytes after a yes to STARTTLS: not a TLS record, so the handshake dies at once. */
const NOT_A_SERVER_HELLO = "plaintext-garbage-not-a-server-hello\r\n";

/**
 * A line server. After the handler says yes to STARTTLS (`saidYes`), lines are still RECORDED,
 * so a plaintext LOGIN stays visible to the transcript checks, but never ANSWERED: the client's
 * ClientHello holds a CRLF in a few percent of runs, and answering that "line" echoes bytes that
 * start like a TLS record header, so the client waits for the rest until imapflow's 10 s
 * upgrade timer. The first chunk after the yes gets {@link NOT_A_SERVER_HELLO} instead.
 */
function serve(onLine: (line: string, write: (s: string) => void, saidYes: () => void) => void, greeting: string): Promise<Fake> {
  const lines: string[] = [];
  const live = new Set<net.Socket>();
  const srv = net.createServer((sock) => {
    live.add(sock);
    sock.on("error", () => { /* a client that hangs up mid-refusal is the normal case here */ });
    sock.on("close", () => live.delete(sock));
    const write = (s: string): void => { if (!sock.destroyed) sock.write(s); };
    let upgraded = false;
    let refused = false;
    const saidYes = (): void => { upgraded = true; };
    let buf = "";
    sock.on("data", (d) => {
      const afterYes = upgraded;
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        lines.push(line);
        if (!upgraded) onLine(line, write, saidYes);
      }
      if (afterYes && !refused) { refused = true; write(NOT_A_SERVER_HELLO); }
    });
    write(greeting);
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      port: (srv.address() as net.AddressInfo).port,
      lines,
      close: () => new Promise<void>((res) => { for (const s of live) s.destroy(); srv.close(() => res()); }),
    }));
  });
}

/**
 * An IMAP server that will happily take a cleartext password — which is the whole point.
 *
 * By default `LOGIN` is answered `NO`, so a test can tell "the credentials reached the wire"
 * (a transcript line) apart from "the session completed". `acceptLogin` completes the
 * session instead, which the SMTP tests need: `ImapAdapter` only builds its transporter
 * after a successful IMAP login.
 */
function fakeImap(o: { advertiseStartTls?: boolean; startTlsReply?: "OK" | "BAD"; acceptLogin?: boolean } = {}): Promise<Fake> {
  const caps = `IMAP4rev1${o.advertiseStartTls ? " STARTTLS" : ""}`;
  return serve((line, write, saidYes) => {
    const [tag, cmd, ...args] = line.split(" ");
    const c = (cmd ?? "").toUpperCase();
    if (c === "CAPABILITY") write(`* CAPABILITY ${caps}\r\n${tag} OK done\r\n`);
    else if (c === "STARTTLS") {
      if (o.startTlsReply === "OK") {
        write(`${tag} OK begin TLS\r\n`);
        // The next bytes are the client's ClientHello, which this plaintext fake cannot answer:
        // `serve` replies with garbage so the handshake dies IMMEDIATELY (OpenSSL's "wrong
        // version number") instead of hanging the suite until imapflow's upgrade timer.
        saidYes();
      } else {
        write(`${tag} BAD TLS unavailable\r\n`);
      }
    }
    else if (c === "LOGIN") write(o.acceptLogin ? `${tag} OK logged in\r\n` : `${tag} NO fake server refuses every password\r\n`);
    // `LIST "" ""` is imapflow's delimiter probe and must answer with the delimiter only,
    // or the folder it names becomes the namespace prefix for every later LIST.
    else if (c === "LIST" && args.join(" ") === `"" ""`) write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
    else if (c === "LIST") write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
    else if (c === "LSUB") write(`* LSUB (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
    else if (c === "LOGOUT") write(`* BYE\r\n${tag} OK\r\n`);
    else write(`${tag} BAD unsupported\r\n`);
  }, `* OK [CAPABILITY ${caps}] fake imap ready\r\n`);
}

/**
 * An SMTP server that advertises AUTH — necessary, not incidental: nodemailer only sends
 * `AUTH` when the server offers it, so without this line the "no AUTH reached the wire"
 * assertion would pass for the wrong reason and survive the mutation it exists to catch.
 */
function fakeSmtp(o: { advertiseStartTls?: boolean; startTlsReply?: "220" | "454" } = {}): Promise<Fake> {
  return serve((line, write, saidYes) => {
    const c = line.toUpperCase();
    if (c.startsWith("EHLO")) {
      write(`250-fake greets you\r\n${o.advertiseStartTls ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN LOGIN\r\n`);
    } else if (c.startsWith("HELO")) write("250 fake\r\n");
    else if (c.startsWith("STARTTLS")) {
      if (o.startTlsReply === "220") { write("220 go ahead\r\n"); saidYes(); } else write("454 TLS not available\r\n");
    }
    else if (c.startsWith("AUTH")) write("535 fake server refuses every password\r\n");
    else if (c.startsWith("QUIT")) write("221 bye\r\n");
    else write("500 unsupported\r\n");
  }, "220 fake ESMTP ready\r\n");
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });
async function open<T extends Fake>(p: Promise<T>): Promise<T> {
  const f = await p; closers.push(f.close); return f;
}

// ─── the hosts, real ones ────────────────────────────────────────────────────────────────

/** Every IMAP/SMTP host ohmail actually connects to. `apps/webapp/app/shell/providers.ts`
 *  plus `mailbox_credentials.meta.host` for both live production mailboxes (2026-08-03). */
const PRODUCTION_HOSTS = [
  "imap.gmail.com", "smtp.gmail.com",
  "outlook.office365.com", "smtp.office365.com",
  "imap.mail.me.com", "smtp.mail.me.com",
  "imap.mail.yahoo.com", "smtp.mail.yahoo.com",
  "imap.fastmail.com", "smtp.fastmail.com",
  "imap.gmx.net", "mail.gmx.net",
  "mail.infomaniak.com",
  "copernicus.sui-inter.net",
] as const;

/** The thing that must never appear in a transcript. */
const PASSWORD = "s3cr3t-app-password";

const prodCfg = (over: Partial<ImapConfig> = {}): ImapConfig => ({
  host: "imap.example.net", port: 143, secure: false,
  auth: { user: "victim@example.net", pass: PASSWORD },
  smtp: { host: "smtp.example.net", port: 587, secure: false, auth: { user: "victim@example.net", pass: PASSWORD } },
  timeouts: { connectionMs: 4000, greetingMs: 4000, socketMs: 4000 },
  ...over,
});

// ─── the loopback predicate ──────────────────────────────────────────────────────────────

const LOOPBACK_REFUSED = [...PRODUCTION_HOSTS, ...LOOPBACK_LOOKALIKES];

describe("loopbackHarnessReason — the test harness and the desktop's local door (any typed loopback host)", () => {
  it("names a reason for every form a host on this computer is reached by", () => {
    for (const host of LOOPBACK_ADMITTED) {
      expect(loopbackHarnessReason(host), host).toMatch(/loopback|localhost/i);
    }
  });

  it("refuses every lookalike — each rejection makes the connection stricter, never looser", () => {
    for (const host of LOOPBACK_REFUSED) {
      expect(loopbackHarnessReason(host), host).toBeNull();
    }
  });

  it("the window's copy (`local-server-host.ts`) answers every row the same way", () => {
    for (const host of [...LOOPBACK_ADMITTED, ...LOOPBACK_REFUSED]) {
      expect(isLocalServerHost(host), host).toBe(loopbackHarnessReason(host) !== null);
    }
  });
});

// ─── the floor, as options ───────────────────────────────────────────────────────────────

describe("the floor cannot be absent for a real provider", () => {
  it("IMAP: every production host, on either port shape, is TLS-or-refuse with strict certs", () => {
    for (const host of PRODUCTION_HOSTS) {
      for (const secure of [true, false]) {
        const { options, exemptReason } = imapTlsFloor(host, secure);
        expect(exemptReason, host).toBeNull();
        expect(options.tls, host).toEqual(TLS_FLOOR);
        expect(options.tls!.rejectUnauthorized, host).toBe(true);
        expect(options.tls!.minVersion, host).toBe("TLSv1.2");
        // The invariant: implicit TLS, or a MANDATORY upgrade. Never opportunistic.
        expect(options.secure === true || options.doSTARTTLS === true, `${host} secure=${secure}`).toBe(true);
        // …and never both, which imapflow rejects outright as a misconfiguration.
        expect(options.secure === true && options.doSTARTTLS === true, host).toBe(false);
      }
    }
  });

  it("SMTP: same, plus the two options that would silently reopen the hole are pinned false", () => {
    for (const host of PRODUCTION_HOSTS) {
      for (const secure of [true, false]) {
        const { options, exemptReason } = smtpTlsFloor(host, secure);
        expect(exemptReason, host).toBeNull();
        expect(options.tls, host).toEqual(TLS_FLOOR);
        expect(options.secure === true || options.requireTLS === true, `${host} secure=${secure}`).toBe(true);
        // `ignoreTLS` skips STARTTLS entirely; `opportunisticTLS` downgrades a FAILED
        // upgrade to "continue unencrypted". Either one alone undoes the floor.
        expect(options.ignoreTLS, host).toBe(false);
        expect(options.opportunisticTLS, host).toBe(false);
      }
    }
  });

  it("the exemption adds nothing and removes nothing — it declines to add the floor", () => {
    expect(imapTlsFloor("127.0.0.1", false)).toEqual({
      options: { secure: false }, exemptReason: "the host is in the IPv4 loopback range 127.0.0.0/8",
    });
    expect(smtpTlsFloor("127.0.0.1", false)).toEqual({
      options: { secure: false }, exemptReason: "the host is in the IPv4 loopback range 127.0.0.0/8",
    });
  });

  it("SNI IS PINNED, not inherited: every DNS-named host carries servername, no IP literal does", () => {
    // Both imapflow and nodemailer happen to derive SNI from the host today; the pin is what
    // makes that a floor rather than a coincidence of two dependencies' internals. A multi-vhost
    // server presents its DEFAULT certificate to a dial with no SNI — a refusal that looks
    // exactly like a wrong certificate, on a mailbox every other client connects to fine.
    for (const host of PRODUCTION_HOSTS) {
      for (const secure of [true, false]) {
        expect(imapTlsFloor(host, secure).options.servername, host).toBe(host);
        expect(smtpTlsFloor(host, secure).options.servername, host).toBe(host);
      }
    }
    // RFC 6066 §3 forbids an IP literal in SNI — matching both libraries' own rule.
    for (const host of ["203.0.113.10", "[2001:db8::1]", "2001:db8::1"]) {
      expect(imapTlsFloor(host, true).options.servername, host).toBeUndefined();
      expect(smtpTlsFloor(host, true).options.servername, host).toBeUndefined();
    }
  });

  it("THE CONSENT BRANCH trades the mandatory upgrade for an opportunistic one — and nothing else", () => {
    const consented = imapTlsFloor("mail.tlsless.example", false, true);
    // No doSTARTTLS: imapflow upgrades when the server offers STARTTLS and proceeds in
    // plaintext when it does not — which is what the user consented to.
    expect(consented.options).toEqual({
      secure: false, servername: "mail.tlsless.example", tls: TLS_FLOOR,
    });
    // Certificate validation of any upgrade that DOES happen is untouched.
    expect(consented.options.tls!.rejectUnauthorized).toBe(true);
    // An implicit-TLS config ignores the flag entirely: there is nothing to consent away.
    expect(imapTlsFloor("mail.tlsless.example", true, true).options)
      .toEqual(imapTlsFloor("mail.tlsless.example", true).options);
    // And without the flag the floor is exactly what it always was.
    expect(imapTlsFloor("mail.tlsless.example", false).options.doSTARTTLS).toBe(true);
  });

  it("THE SMTP CONSENT BRANCH drops only `requireTLS`: an offered upgrade is taken and a failed one stays fatal", () => {
    expect(smtpTlsFloor("smtp.tlsless.example", false, true).options).toEqual({
      secure: false, ignoreTLS: false, opportunisticTLS: false, servername: "smtp.tlsless.example", tls: TLS_FLOOR,
    });
    expect(smtpTlsFloor("smtp.tlsless.example", true, true).options)
      .toEqual(smtpTlsFloor("smtp.tlsless.example", true).options);
    expect(smtpTlsFloor("smtp.tlsless.example", false).options.requireTLS).toBe(true);
  });

  it("the whole option set the adapter builds carries the floor, not just the TLS slice", () => {
    const imap = imapFlowOptions(prodCfg()) as Record<string, unknown>;
    expect(imap.host).toBe("imap.example.net");
    expect(imap.secure).toBe(false);
    expect(imap.doSTARTTLS).toBe(true);
    expect(imap.tls).toEqual(TLS_FLOOR);
    // imapflow's proxy client is the one dial path this adapter never configures.
    expect("proxy" in imap).toBe(false);

    const smtp = smtpTransportOptions(prodCfg()) as Record<string, unknown>;
    expect(smtp.host).toBe("smtp.example.net");
    expect(smtp.secure).toBe(false);
    expect(smtp.requireTLS).toBe(true);
    expect(smtp.tls).toEqual(TLS_FLOOR);
    expect(smtp.disableFileAccess).toBe(true);
    expect(smtp.disableUrlAccess).toBe(true);
  });
});

// ─── the wire: IMAP ──────────────────────────────────────────────────────────────────────

/** Did the user's password cross the socket in clear text? The only question that matters. */
const sawLogin = (f: Fake): boolean => f.lines.some((l) => /^\S+\s+LOGIN\b/i.test(l));
const sawAuth = (f: Fake): boolean => f.lines.some((l) => /^AUTH\b/i.test(l));

/** A config whose IMAP leg is the fake server, on the host the caller names. */
const wireCfg = (host: string, port: number, smtp?: { host: string; port: number }): ImapConfig => ({
  host, port, secure: false,
  auth: { user: "victim@example.net", pass: PASSWORD },
  ...(smtp ? { smtp: { host: smtp.host, port: smtp.port, secure: false, auth: { user: "victim@example.net", pass: PASSWORD } } } : {}),
  sentDomain: "example.net",
  timeouts: { connectionMs: 4000, greetingMs: 4000, socketMs: 4000 },
});

describe("IMAP on the wire", () => {
  it("a server that offers NO encryption never receives the password", async () => {
    const srv = await open(fakeImap({ advertiseStartTls: false }));
    const adapter = new ImapAdapter(wireCfg("0.0.0.0", srv.port));

    const err = await adapter.connect().then(() => null, (e: Error) => e);

    // The leak first, so a regression reports the leak rather than an error string.
    expect(sawLogin(srv), `LOGIN reached the wire. transcript: ${JSON.stringify(srv.lines)}`).toBe(false);
    expect(srv.lines.join("\n"), "the password reached the wire").not.toContain(PASSWORD);
    expect(err?.message).toMatch(/does not support STARTTLS/i);
  });

  it("a server that ADVERTISES STARTTLS and then refuses it never receives the password either", async () => {
    const srv = await open(fakeImap({ advertiseStartTls: true, startTlsReply: "BAD" }));
    const adapter = new ImapAdapter(wireCfg("0.0.0.0", srv.port));

    const err = await adapter.connect().then(() => null, (e: Error) => e);

    expect(sawLogin(srv), `LOGIN reached the wire. transcript: ${JSON.stringify(srv.lines)}`).toBe(false);
    expect(srv.lines.join("\n"), "the password reached the wire").not.toContain(PASSWORD);
    expect(srv.lines.some((l) => /STARTTLS/i.test(l)), "the upgrade must be ATTEMPTED").toBe(true);
    expect(err?.message).toMatch(/STARTTLS/i);
  });

  it("CONSENT, PROVEN ON THE WIRE: with `allowInsecure` a no-TLS server does receive the LOGIN", async () => {
    // The mirror image of the first test in this describe — same server, same non-exempt host,
    // ONE flag different — so together they are the mutation pair: remove the consent branch
    // and this goes red; make the branch reachable without the flag and the first one does.
    const srv = await open(fakeImap({ advertiseStartTls: false }));
    const adapter = new ImapAdapter({ ...wireCfg("0.0.0.0", srv.port), allowInsecure: true });

    const err = await adapter.connect().then(() => null, (e: Error) => e);

    expect(sawLogin(srv), `transcript: ${JSON.stringify(srv.lines)}`).toBe(true);
    // The fake refuses every password, so the failure is the LOGIN's — never a STARTTLS refusal.
    expect(err?.message).not.toMatch(/STARTTLS/i);
  });

  it("CONSENT STILL PREFERS THE UPGRADE: a server that advertises STARTTLS gets the attempt, not plaintext", async () => {
    const srv = await open(fakeImap({ advertiseStartTls: true, startTlsReply: "OK" }));
    const adapter = new ImapAdapter({ ...wireCfg("0.0.0.0", srv.port), allowInsecure: true });

    // The fake cannot actually speak TLS, so the upgrade dies in the handshake — which IS the
    // assertion: a consented mailbox on a server that has grown STARTTLS goes through the
    // validated upgrade path (and fails on a fake certificate) rather than staying plaintext.
    const err = await adapter.connect().then(() => null, (e: Error) => e);

    expect(srv.lines.some((l) => /STARTTLS/i.test(l)), "the upgrade must be ATTEMPTED").toBe(true);
    expect(sawLogin(srv), `LOGIN reached the wire in plaintext. transcript: ${JSON.stringify(srv.lines)}`).toBe(false);
    expect(srv.lines.join("\n")).not.toContain(PASSWORD);
    expect(err).toBeInstanceOf(Error);
  });

  it("the fake RECORDS what follows its yes to STARTTLS and answers none of it", async () => {
    // What keeps the case above from hanging, and its transcript honest: a LOGIN after the yes
    // is on `lines` for `sawLogin`, and the only reply is the garbage that ends the handshake.
    const srv = await open(fakeImap({ advertiseStartTls: true, startTlsReply: "OK" }));
    const sock = net.connect(srv.port, "127.0.0.1");
    closers.push(async () => { sock.destroy(); });
    sock.on("error", () => { /* closed by the afterEach */ });
    sock.setEncoding("utf8");
    let got = "";
    const waiters: Array<() => void> = [];
    sock.on("data", (d: string) => { got += d; for (const w of waiters.splice(0)) w(); });
    const seen = async (s: string): Promise<void> => {
      while (!got.includes(s)) await new Promise<void>((r) => waiters.push(r));
    };

    await seen("fake imap ready\r\n");
    sock.write("a1 STARTTLS\r\n");
    await seen("a1 OK begin TLS\r\n");
    const before = got.length;
    sock.write(`a2 LOGIN victim ${PASSWORD}\r\n`);
    await seen(NOT_A_SERVER_HELLO);

    expect(got.slice(before), "a line after the yes was answered").toBe(NOT_A_SERVER_HELLO);
    expect(sawLogin(srv), `transcript: ${JSON.stringify(srv.lines)}`).toBe(true);
  });

  it("LOOPBACK still authenticates — and that is the only reason the plaintext harness works", async () => {
    const srv = await open(fakeImap({ advertiseStartTls: false }));
    const adapter = new ImapAdapter(wireCfg("127.0.0.1", srv.port));

    // The fake refuses every password, so this rejects. WHERE it rejects is the assertion:
    // at the LOGIN, not at the upgrade. imapflow reports a `NO` to LOGIN as the generic
    // "Command failed", so the discriminator is that the message is not about STARTTLS…
    const err = await adapter.connect().then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toMatch(/STARTTLS/i);
    // …and that the credentials really did cross the socket, which is the whole point of
    // the exemption and the thing the two tests above prove a provider host cannot do.
    expect(sawLogin(srv), `transcript: ${JSON.stringify(srv.lines)}`).toBe(true);
  });
});

// ─── the wire: SMTP ──────────────────────────────────────────────────────────────────────

/**
 * Both SMTP tests put the IMAP leg on `127.0.0.1` and vary only the SMTP host, which is
 * incidentally the proof that the two legs are decided independently: `ImapAdapter` builds
 * its transporter inside `connect()`, so the IMAP half has to succeed before the SMTP half
 * can be reached at all.
 */
async function connectedAdapter(
  smtpHost: string, smtpPort: number, smtpConsent = false,
): Promise<{ adapter: ImapAdapter; imap: Fake }> {
  const imap = await open(fakeImap({ acceptLogin: true }));
  const cfg = wireCfg("127.0.0.1", imap.port, { host: smtpHost, port: smtpPort });
  const adapter = new ImapAdapter(smtpConsent ? { ...cfg, smtp: { ...cfg.smtp!, allowInsecure: true } } : cfg);
  closers.push(() => adapter.close().catch(() => undefined));
  await adapter.connect();
  return { adapter, imap };
}

const outbound = {
  from: "victim@example.net", to: "someone@example.org",
  subject: "does this leak", text: "it must not",
};

describe("SMTP on the wire", () => {
  it("a submission server that offers no encryption never receives the password", async () => {
    const srv = await open(fakeSmtp({ advertiseStartTls: false }));
    const { adapter } = await connectedAdapter("0.0.0.0", srv.port);

    const err = await adapter.send(outbound).then(() => null, (e: Error & { code?: string }) => e);

    expect(sawAuth(srv), `AUTH reached the wire. transcript: ${JSON.stringify(srv.lines)}`).toBe(false);
    expect(srv.lines.join("\n"), "the password reached the wire").not.toContain(PASSWORD);
    expect(srv.lines.some((l) => /^STARTTLS/i.test(l)), "the upgrade must be ATTEMPTED even unadvertised").toBe(true);
    expect(err?.code).toBe("ETLS");
  });

  it("THE SMTP CONSENT: a consented server with no STARTTLS takes the login in plaintext, as consented", async () => {
    const srv = await open(fakeSmtp({ advertiseStartTls: false }));
    const { adapter } = await connectedAdapter("0.0.0.0", srv.port, true);

    // Reached AUTH (the fake refuses every password), and no upgrade was demanded of a server with none.
    await expect(adapter.send(outbound)).rejects.toMatchObject({ code: "EAUTH" });
    expect(sawAuth(srv), `transcript: ${JSON.stringify(srv.lines)}`).toBe(true);
    expect(srv.lines.some((l) => /^STARTTLS/i.test(l))).toBe(false);
  });

  it("a consented server that ADVERTISES STARTTLS is upgraded, and a failed upgrade never falls back to plaintext", async () => {
    const srv = await open(fakeSmtp({ advertiseStartTls: true, startTlsReply: "454" }));
    const { adapter } = await connectedAdapter("0.0.0.0", srv.port, true);

    const err = await adapter.send(outbound).then(() => null, (e: Error & { code?: string }) => e);
    expect(srv.lines.some((l) => /^STARTTLS/i.test(l)), "an offered upgrade was skipped").toBe(true);
    expect(sawAuth(srv), `AUTH reached the wire. transcript: ${JSON.stringify(srv.lines)}`).toBe(false);
    expect(err).not.toBeNull();
  });

  it("LOOPBACK still authenticates — the plaintext GreenMail send path is unchanged", async () => {
    const srv = await open(fakeSmtp({ advertiseStartTls: false }));
    const { adapter } = await connectedAdapter("127.0.0.1", srv.port);

    // Reached AUTH and was refused there — an authentication failure, not a TLS one.
    await expect(adapter.send(outbound)).rejects.toMatchObject({ code: "EAUTH" });

    expect(sawAuth(srv), `transcript: ${JSON.stringify(srv.lines)}`).toBe(true);
  });
});
