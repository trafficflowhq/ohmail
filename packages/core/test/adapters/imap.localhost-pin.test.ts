import dns from "node:dns";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { ImapAdapter, imapFlowOptions, smtpTransportOptions } from "../../src/adapters/imap.js";
import { loopbackHarnessReason } from "../../src/adapters/imap-types.js";

/**
 * H2: THE PLAINTEXT EXEMPTION IS FOR AN ADDRESS THAT IS LOOPBACK. The name `localhost` keeps it only
 * because every dial pins it to 127.0.0.1 on both legs, so no resolver is asked; a name under
 * `.localhost` is an ordinary name and takes the TLS floor. Measured before: `gw.localhost` resolved
 * elsewhere connected there and sent LOGIN in clear.
 */

const AUTH = { user: "someone", pass: "inert-label-password" };
const restores: Array<() => void> = [];
afterEach(() => { while (restores.length > 0) restores.pop()!(); });

describe("the options a dial is built from", () => {
  it("localhost: no TLS floor, and the IMAP lookup answers 127.0.0.1 whatever is asked", async () => {
    const o = imapFlowOptions({ host: "localhost", port: 1143, secure: false, auth: AUTH });
    expect(o).not.toHaveProperty("doSTARTTLS");
    const lookup = (o.tls as { lookup?: net.LookupFunction } | undefined)?.lookup;
    expect(lookup, "localhost is dialled by name").toBeTypeOf("function");
    const answer = await new Promise<string>((done) => lookup!("localhost", {}, (_e, a) => done(String(a))));
    expect(answer).toBe("127.0.0.1");
  });

  it("localhost: the SMTP leg dials 127.0.0.1 and keeps the name for the certificate", () => {
    const o = smtpTransportOptions({
      host: "localhost", port: 1143, secure: false, auth: AUTH,
      smtp: { host: "localhost", port: 1025, secure: false, auth: AUTH },
    });
    expect(o.host).toBe("127.0.0.1");
    expect((o as { servername?: string }).servername).toBe("localhost");
  });

  it("a name under .localhost is an ordinary name: the floor, and no pin", () => {
    for (const host of ["gw.localhost", "davmail.localhost"]) {
      expect(loopbackHarnessReason(host), host).toBeNull();
      const o = imapFlowOptions({ host, port: 1143, secure: false, auth: AUTH });
      expect(o, host).toMatchObject({ secure: false, doSTARTTLS: true });
      expect((o.tls as { lookup?: unknown } | undefined)?.lookup, host).toBeUndefined();
      const s = smtpTransportOptions({ host, port: 1143, secure: false, auth: AUTH, smtp: { host, port: 1025, secure: false } });
      expect(s.host, host).toBe(host);
      expect(s, host).toMatchObject({ requireTLS: true });
    }
  });

  it("LOW 1: [::1] is dialled at ::1 on both legs, never handed to a resolver as a name", async () => {
    for (const host of ["[::1]", "[0:0:0:0:0:0:0:1]"]) {
      const o = imapFlowOptions({ host, port: 1143, secure: false, auth: AUTH });
      const lookup = (o.tls as { lookup?: net.LookupFunction } | undefined)?.lookup;
      expect(lookup, host).toBeTypeOf("function");
      const answer = await new Promise<string>((done) => lookup!(host, {}, (_e, a) => done(String(a))));
      expect(answer, host).toBe("::1");
      const s = smtpTransportOptions({ host, port: 1143, secure: false, auth: AUTH, smtp: { host, port: 1025, secure: false } });
      expect(s.host, host).toBe("::1");
      expect((s as { servername?: string }).servername, host).toBeUndefined();
    }
  });

  it("an address literal needs no pin: it is the address (control)", () => {
    const o = imapFlowOptions({ host: "127.0.0.1", port: 1143, secure: false, auth: AUTH });
    expect((o.tls as { lookup?: unknown } | undefined)?.lookup).toBeUndefined();
    expect(smtpTransportOptions({
      host: "127.0.0.1", port: 1143, secure: false, auth: AUTH, smtp: { host: "127.0.0.1", port: 1025, secure: false },
    }).host).toBe("127.0.0.1");
  });
});

describe("a dial to [::1] goes to ::1 whatever a resolver answers (LOW 1)", () => {
  it("the resolver says 127.0.0.2 for the bracketed name; the connection and the LOGIN arrive at ::1", async () => {
    const seen = { connections: 0, logins: 0 };
    const server = net.createServer((sock) => {
      seen.connections++;
      sock.write("* OK [CAPABILITY IMAP4rev1] pin fixture ready\r\n");
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("latin1");
        for (let nl = buf.indexOf("\r\n"); nl >= 0; nl = buf.indexOf("\r\n")) {
          const [tag = "", verb = ""] = buf.slice(0, nl).split(" ");
          buf = buf.slice(nl + 2);
          if (verb.toUpperCase() === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
          else if (verb.toUpperCase() === "LOGIN") { seen.logins++; sock.write(`${tag} NO [AUTHENTICATIONFAILED] fixture\r\n`); }
          else if (tag) sock.write(`${tag} BAD no\r\n`);
        }
      });
      sock.on("error", () => { /* the client hangs up */ });
    });
    await new Promise<void>((r) => server.listen(0, "::1", r));
    restores.push(() => server.close());
    const port = (server.address() as net.AddressInfo).port;
    const asked: string[] = [];
    const real = dns.lookup;
    dns.lookup = function lookup(host: string, opts: unknown, cb?: unknown) {
      const done = (typeof opts === "function" ? opts : cb) as (e: null, a: unknown, f?: number) => void;
      const all = typeof opts === "object" && opts !== null && (opts as { all?: boolean }).all === true;
      if (String(host).includes("::1")) {
        asked.push(String(host));
        queueMicrotask(() => (all ? done(null, [{ address: "127.0.0.2", family: 4 }]) : done(null, "127.0.0.2", 4)));
        return;
      }
      return (real as unknown as (...a: unknown[]) => unknown).call(dns, host, opts, cb);
    } as typeof dns.lookup;
    restores.push(() => { dns.lookup = real; });

    const adapter = new ImapAdapter({
      host: "[::1]", port, secure: false, auth: AUTH,
      timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 3_000 },
    });
    await adapter.connect().then(() => null, (e: unknown) => e);
    await adapter.close().catch(() => undefined);
    expect(asked, "the bracketed form was handed to a resolver").toEqual([]);
    expect(seen.connections, "the dial never reached ::1").toBe(1);
    expect(seen.logins).toBe(1);
  });
});

describe("a dial to localhost goes to 127.0.0.1 whatever a resolver answers", () => {
  it("the resolver says 127.0.0.2; the connection and the LOGIN arrive at 127.0.0.1", async () => {
    const seen = { connections: 0, logins: 0 };
    const server = net.createServer((sock) => {
      seen.connections++;
      sock.write("* OK [CAPABILITY IMAP4rev1] pin fixture ready\r\n");
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("latin1");
        for (let nl = buf.indexOf("\r\n"); nl >= 0; nl = buf.indexOf("\r\n")) {
          const [tag = "", verb = ""] = buf.slice(0, nl).split(" ");
          buf = buf.slice(nl + 2);
          if (verb.toUpperCase() === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
          else if (verb.toUpperCase() === "LOGIN") { seen.logins++; sock.write(`${tag} NO [AUTHENTICATIONFAILED] fixture\r\n`); }
          else if (tag) sock.write(`${tag} BAD no\r\n`);
        }
      });
      sock.on("error", () => { /* the client hangs up */ });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    restores.push(() => server.close());
    const port = (server.address() as net.AddressInfo).port;
    // A resolver answer for the name, as a hostile or misconfigured one would give it. 127.0.0.2 is
    // loopback too, so nothing leaves the machine, and nothing listens there: an unpinned dial fails.
    const real = dns.lookup;
    dns.lookup = function lookup(host: string, opts: unknown, cb?: unknown) {
      const done = (typeof opts === "function" ? opts : cb) as (e: null, a: unknown, f?: number) => void;
      const all = typeof opts === "object" && opts !== null && (opts as { all?: boolean }).all === true;
      if (String(host).toLowerCase() === "localhost") {
        queueMicrotask(() => (all ? done(null, [{ address: "127.0.0.2", family: 4 }]) : done(null, "127.0.0.2", 4)));
        return;
      }
      return (real as unknown as (...a: unknown[]) => unknown).call(dns, host, opts, cb);
    } as typeof dns.lookup;
    restores.push(() => { dns.lookup = real; });

    const adapter = new ImapAdapter({
      host: "localhost", port, secure: false, auth: AUTH,
      timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 3_000 },
    });
    const err = await adapter.connect().then(() => null, (e: unknown) => e);
    await adapter.close().catch(() => undefined);
    expect(seen.connections, "the dial never reached 127.0.0.1").toBe(1);
    expect(seen.logins, "the LOGIN went somewhere else").toBe(1);
    expect(err, "the fixture's NO ends the connect").not.toBeNull();
  });
});
