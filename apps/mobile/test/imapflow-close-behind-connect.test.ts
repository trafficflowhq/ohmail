import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  IMAPFLOW_CLOSE_MARKER, IMAPFLOW_REARM_VERSION, bundleProbe, deferImapflowCloseBehindConnect,
} from "../scripts/bundle-engine.mjs";
import { platformDouble, type DoubleOptions } from "./_platform-socket-double";

/**
 * A REFUSED STARTTLS CERTIFICATE REACHES IMAPFLOW'S `connect()` ON THE PHONE.
 *
 * imapflow settles a failed upgrade with `closeAfter()` before its rejection travels up to the
 * pending `connect()`. On a phone `setImmediate` is a microtask, so the close ran first and
 * rejected the connect with `Unexpected close` and no flag: the engine read a refused certificate
 * as an outage, and the Ohbox said "Reconnecting…" while the server logged refused handshakes.
 * The phone bundle defers that close behind the pending connect (`bundle-engine.mjs`). The
 * bundle's own imapflow runs here over the real shims and the platform double, against a server
 * whose certificate the double does not trust.
 */
const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const coreReq = createRequire(join(here, "../../../packages/core/package.json"));
const SHIMS = join(here, "../src/engine/shims");
const PASSWORD = "close-behind-connect-password-password";

/** What the platforms say, as the shim receives it. */
const ANDROID = "javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.";
const ANDROID_PATCHED = `the TLS upgrade failed: ${ANDROID}`;
const IOS = "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9807.)";

let dir = "";
let probeDir = "";
let phoneTrust = "";
let untrusted: { key: Buffer; cert: Buffer };
let trusted: { key: Buffer; cert: Buffer };
/** One double for the file; each case sets how the platform ends a refused upgrade. */
const platform: DoubleOptions = {};
let phone: { ImapFlow: new (o: object) => Client };

interface Client {
  connect(): Promise<void>;
  close(): void;
  on(event: string, fn: (e: unknown) => void): void;
}
type Refusal = Error & { code?: string; tlsFailed?: boolean; certificateRefused?: boolean; certificateKind?: string };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "close-behind-connect-"));
  const o = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "ignore" });
  const leaf = (name: string, ca: string) => {
    o("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", "/CN=localhost");
    writeFileSync(join(dir, `${name}.ext`), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
    o("x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.pem`, "-CAkey", `${ca}.key`, "-CAcreateserial",
      "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`);
    return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) };
  };
  /* The server's private CA, and the one the phone trusts. */
  o("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "private.key", "-out", "private.pem", "-days", "2", "-subj", "/CN=a private CA");
  o("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "public.key", "-out", "public.pem", "-days", "2", "-subj", "/CN=the phone's trust");
  untrusted = leaf("untrusted", "private");
  trusted = leaf("trusted", "public");
  phoneTrust = readFileSync(join(dir, "public.pem"), "utf8");

  const probe = await bundleProbe('export { ImapFlow } from "imapflow";\n');
  probeDir = probe.dir;
  phone = load(() => req(probe.bundlePath)) as typeof phone;
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (probeDir) rmSync(probeDir, { recursive: true, force: true });
});

/** Code loaded with the platform socket answered by the double, and crypto by node's. */
let double: ReturnType<typeof platformDouble> | null = null;
function load(get: () => unknown, upstreamShims = false): unknown {
  double ??= platformDouble(phoneTrust, platform);
  const Module = req("node:module") as { _load(r: string, p: { filename?: string } | undefined, m: boolean): unknown };
  const original = Module._load;
  let shims: { net: unknown; tls: unknown } | null = null;
  Module._load = function hooked(r, parent, isMain) {
    if (r === "react-native-tcp-socket") return double!.module;
    if (r === "react-native-quick-crypto") return req("node:crypto");
    if (shims && parent?.filename?.includes("/imapflow/") && (r === "net" || r === "tls")) return shims[r];
    return original.call(this, r, parent, isMain);
  };
  try {
    if (upstreamShims) {
      const cache = (req as unknown as { cache: Record<string, unknown> }).cache;
      for (const k of Object.keys(cache)) if (k.includes("engine/shims/") || k.includes("/imapflow/")) delete cache[k];
      shims = { net: req(join(SHIMS, "net.js")), tls: req(join(SHIMS, "tls.js")) };
    }
    return get();
  } finally { Module._load = original; }
}

/** React Native's `setImmediate` as bridgeless 0.86 installs it: a `queueMicrotask` shim. */
const nodeSetImmediate = globalThis.setImmediate;
function onThePhonesScheduler(): void {
  (globalThis as { setImmediate: unknown }).setImmediate = (cb: (...a: unknown[]) => void, ...args: unknown[]) => {
    globalThis.queueMicrotask(() => { cb.apply(undefined, args); });
    return 0;
  };
}

interface Fake { port: number; logins(): number; upgrades(): number; close(): Promise<void> }
const servers: Fake[] = [];
afterEach(async () => {
  (globalThis as { setImmediate: unknown }).setImmediate = nodeSetImmediate;
  for (const s of servers.splice(0)) await s.close();
});

/** IMAP on a plain port that upgrades with STARTTLS, presenting `identity`; counts upgrades and every LOGIN. */
function starttlsImap(identity: { key: Buffer; cert: Buffer }): Promise<Fake> {
  let logins = 0;
  let upgrades = 0;
  const live = new Set<net.Socket>();
  const server = net.createServer((plain) => {
    live.add(plain);
    plain.on("close", () => live.delete(plain));
    plain.on("error", () => undefined);
    const session = (sock: net.Socket, secured: boolean): void => {
      let buf = "";
      const write = (s: string): void => { if (!sock.destroyed) sock.write(s); };
      const onData = (d: Buffer): void => {
        buf += d.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const [tag, cmd, ...args] = line.split(" ");
          const c = (cmd ?? "").toUpperCase();
          if (c === "CAPABILITY") write(`* CAPABILITY IMAP4rev1${secured ? "" : " STARTTLS LOGINDISABLED"}\r\n${tag} OK done\r\n`);
          else if (c === "STARTTLS" && !secured) {
            sock.removeListener("data", onData);
            upgrades += 1;
            write(`${tag} OK begin TLS\r\n`);
            const up = new tls.TLSSocket(sock, { isServer: true, key: identity.key, cert: identity.cert });
            up.on("error", () => undefined);
            session(up as unknown as net.Socket, true);
            return;
          } else if (c === "LOGIN" || c === "AUTHENTICATE") {
            logins += 1;
            write(secured ? `${tag} OK logged in\r\n` : `${tag} NO not over a plain connection\r\n`);
          } else if (c === "LIST" && args.join(" ") === `"" ""`) write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
          else if (c === "LIST") write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
          else if (c === "LOGOUT") write(`* BYE\r\n${tag} OK\r\n`);
          else write(`${tag} NO unsupported here\r\n`);
        }
      };
      sock.on("data", onData);
    };
    plain.write("* OK fake imap ready\r\n");
    session(plain, false);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const fake: Fake = {
      port: (server.address() as net.AddressInfo).port,
      logins: () => logins,
      upgrades: () => upgrades,
      close: () => new Promise<void>((done) => { for (const s of live) s.destroy(); server.close(() => done()); }),
    };
    servers.push(fake);
    resolve(fake);
  }));
}

/** One `connect()` the way the phone's adapter asks for it: STARTTLS required, the floor's TLS options. */
async function dial(ImapFlow: new (o: object) => Client, port: number): Promise<Refusal | null> {
  const client = new ImapFlow({
    host: "127.0.0.1", port, secure: false, doSTARTTLS: true, servername: "localhost",
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth: { user: "someone@example.test", pass: PASSWORD }, logger: false,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000, disableCompression: true,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    client.close();
    return null;
  } catch (e) {
    return e as Refusal;
  }
}

describe("the phone bundle's imapflow, a refused STARTTLS certificate", () => {
  it("Android with the reason on the close: the connect rejects with the certificate, before any LOGIN", async () => {
    Object.assign(platform, { unregisterOnClose: true, refusedUpgrade: "error-first", say: () => ANDROID_PATCHED });
    const server = await starttlsImap(untrusted);
    onThePhonesScheduler();
    const err = await dial(phone.ImapFlow, server.port);
    expect(err, "the dial was admitted").not.toBeNull();
    expect(err!.code, "the close won the race and the reason was lost").not.toBe("ClosedAfterConnectText");
    expect(err!.tlsFailed).toBe(true);
    expect(err!.certificateRefused).toBe(true);
    expect(err!.certificateKind).toBe("untrusted");
    expect(server.upgrades(), "the dial reached the upgrade").toBe(1);
    expect(server.logins(), "a password crossed a refused handshake").toBe(0);
  }, 30_000);

  it("iOS: the same, from the platform's own words", async () => {
    Object.assign(platform, { unregisterOnClose: true, refusedUpgrade: "error-first", say: () => IOS });
    const server = await starttlsImap(untrusted);
    onThePhonesScheduler();
    const err = await dial(phone.ImapFlow, server.port);
    expect(err).not.toBeNull();
    expect(err!.certificateRefused).toBe(true);
    expect(err!.certificateKind).toBe("untrusted");
    expect(server.logins()).toBe(0);
  }, 30_000);

  /* WHY THE TRANSPORT PATCH CARRIES THE REASON: a close heard before the error unregisters the
     socket, the platform's message is never read, and only the upgrade's own bound speaks. */
  it("WITNESS — Android closing first: nothing can name the certificate, only that the upgrade failed", async () => {
    Object.assign(platform, { unregisterOnClose: true, refusedUpgrade: "close-first", say: () => ANDROID });
    const server = await starttlsImap(untrusted);
    onThePhonesScheduler();
    const err = await dial(phone.ImapFlow, server.port);
    expect(err).not.toBeNull();
    expect(err!.tlsFailed).toBe(true);
    expect(err!.certificateRefused).toBeUndefined();
    expect(err!.message).toMatch(/no peer certificate/);
    expect(server.logins()).toBe(0);
  }, 30_000);

  it("WITNESS — upstream imapflow on the phone's scheduler loses the reason: the device's signature", async () => {
    Object.assign(platform, { unregisterOnClose: true, refusedUpgrade: "close-first", say: () => ANDROID });
    const upstream = load(() => coreReq("imapflow"), true) as { ImapFlow: new (o: object) => Client };
    const server = await starttlsImap(untrusted);
    onThePhonesScheduler();
    const err = await dial(upstream.ImapFlow, server.port);
    expect(err).not.toBeNull();
    expect(err!.code).toBe("ClosedAfterConnectText");
    expect(err!.tlsFailed).toBeUndefined();
    expect(server.logins()).toBe(0);
  }, 30_000);

  it("CONTROL — on node's scheduler the refusal already arrived: the fault is the scheduler", async () => {
    Object.assign(platform, { unregisterOnClose: true, refusedUpgrade: "error-first", say: () => ANDROID_PATCHED });
    const server = await starttlsImap(untrusted);
    const err = await dial(phone.ImapFlow, server.port);
    expect(err).not.toBeNull();
    expect(err!.tlsFailed).toBe(true);
    expect(err!.certificateRefused).toBe(true);
    expect(server.logins()).toBe(0);
  }, 30_000);

  it("CONTROL — a certificate the phone trusts upgrades, signs in, and connects", async () => {
    Object.assign(platform, { unregisterOnClose: true, refusedUpgrade: "error-first", say: () => ANDROID_PATCHED });
    const server = await starttlsImap(trusted);
    onThePhonesScheduler();
    const err = await dial(phone.ImapFlow, server.port);
    expect(err, err?.message).toBeNull();
    expect(server.upgrades()).toBe(1);
    expect(server.logins(), "the sign-in happened over the upgraded connection").toBe(1);
  }, 30_000);
});

describe("the rewrite behind it", () => {
  const rewrite = deferImapflowCloseBehindConnect as ((source: string, version: string) => string) | undefined;
  const source = readFileSync(coreReq.resolve("imapflow"), "utf8");

  it("defers the close only while the first connect is pending, and marks it", () => {
    expect(rewrite, "the bundler has no close rewrite").toBeTypeOf("function");
    const out = rewrite!(source, IMAPFLOW_REARM_VERSION);
    expect(out.split(IMAPFLOW_CLOSE_MARKER).length - 1, "the marker, once").toBe(1);
    const body = out.slice(out.indexOf("    closeAfter() {"), out.indexOf("    createConnectionError("));
    expect(body).toContain("if (typeof this.initialReject === 'function') {");
    expect(body).toContain("setTimeout(() => this.close(), 0);");
    expect(body, "the ordinary close keeps its scheduler").toContain("setImmediate(() => this.close());");
  });

  it("refuses another version, and an anchor that does not match exactly once", () => {
    expect(rewrite).toBeTypeOf("function");
    expect(() => rewrite!(source, "1.7.9")).toThrow(/1\.7\.8/);
    expect(() => rewrite!(source.replace("    closeAfter() {", "    closeLater() {"), "1.7.8")).toThrow(/0 times/);
    const anchor = "    closeAfter() {\n        setImmediate(() => this.close());\n    }";
    expect(() => rewrite!(`${source}\n${anchor}\n`, "1.7.8")).toThrow(/2 times/);
  });
});
