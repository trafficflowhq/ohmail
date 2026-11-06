import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import tls from "node:tls";
import { PassThrough } from "node:stream";
import { deliverNative, platformDouble, type DoubleOptions } from "./_platform-socket-double";

/**
 * A STARTTLS SESSION KEEPS FLOWING AFTER THE UPGRADE, ON THE PHONE'S OWN TRANSPORT.
 *
 * The shims (`net.js`, `tls.js`) run over a double of the platform socket that keeps its rule:
 * every byte reaches every JavaScript socket on the connection, and a pause from any of them
 * pauses the one receiver. imapflow unpipes the plain bridge at STARTTLS and never reads it, so
 * before the fix that bridge filled at 16 KiB, paused the receiver, and the upgraded mailbox
 * stalled (measured on a device over IMAP 143). nodemailer's real client and the 465 control ride
 * the same double, in both platforms' shapes: iOS says the upgrade's end as `connect` and has no
 * peer certificate to show, and the 1.0 s certificate poll refused every iOS upgrade (rig, 3/3).
 */

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const coreReq = createRequire(join(here, "../../../packages/core/package.json"));
const SHIMS = join(here, "../src/engine/shims");
const BIG = 40 * 1024;

let dir = "";
let creds: { key: Buffer; cert: Buffer; ca: string };
/** A CA the double trusts and the servers' leaf does not chain to: every handshake is refused. */
let strangerCa = "";

beforeAll(() => {
  execFileSync("openssl", ["version"]);
  dir = mkdtempSync(join(tmpdir(), "starttls-arrives-"));
  const o = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "ignore" });
  o("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=starttls test CA");
  o("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost");
  writeFileSync(join(dir, "leaf.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  o("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "leaf.ext");
  creds = { key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.pem")), ca: readFileSync(join(dir, "ca.pem"), "utf8") };
  o("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "stranger.key", "-out", "stranger.pem", "-days", "2", "-subj", "/CN=a CA this phone does not hold");
  strangerCa = readFileSync(join(dir, "stranger.pem"), "utf8");
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** The shims (and nodemailer, when asked) loaded over the double, fresh for each case. */
function loadTransport(withMailer = false, options: DoubleOptions = {}, ca = creds.ca) {
  const double = platformDouble(ca, options);
  const Module = req("node:module") as { _load(r: string, p: { filename?: string } | undefined, m: boolean): unknown };
  const original = Module._load;
  const cache = (req as unknown as { cache: Record<string, unknown> }).cache;
  for (const k of Object.keys(cache)) if (k.includes("engine/shims/") || k.includes("nodemailer")) delete cache[k];
  let shims: { net: any; tls: any; dns: any } | null = null;
  Module._load = function load(r, parent, isMain) {
    if (r === "react-native-tcp-socket") return double.module;
    if (shims && parent?.filename?.includes("nodemailer") && (r === "net" || r === "tls" || r === "dns")) return shims[r];
    return original.call(this, r, parent, isMain);
  };
  try {
    shims = { net: req(join(SHIMS, "net.js")), tls: req(join(SHIMS, "tls.js")), dns: req(join(SHIMS, "dns.js")) };
    const SMTPConnection = withMailer ? coreReq("nodemailer/lib/smtp-connection/index.js") : null;
    return { ...shims, SMTPConnection, conns: double.conns, restore: () => { Module._load = original; } };
  } catch (e) { Module._load = original; throw e; }
}

/** An IMAP-shaped server: STARTTLS, then one command whose answer is well past 16 KiB. */
function imapServer(): Promise<net.Server> {
  const server = net.createServer((plain) => {
    plain.write("* OK ready\r\n");
    let buf = "";
    const onPlain = (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("a1 STARTTLS\r\n")) {
        plain.removeListener("data", onPlain);
        plain.write("a1 OK begin TLS\r\n");
        const secure = new tls.TLSSocket(plain, { isServer: true, key: creds.key, cert: creds.cert });
        let sbuf = "";
        secure.on("data", (s: Buffer) => {
          sbuf += s.toString();
          if (sbuf.includes("a2 FETCH\r\n")) { sbuf = ""; secure.write(`* 1 FETCH (BODY {${BIG}}\r\n${"x".repeat(BIG)})\r\na2 OK done\r\n`); }
          if (sbuf.includes("a3 NOOP\r\n")) { sbuf = ""; secure.write("a3 OK noop\r\n"); }
        });
        secure.on("error", () => undefined);
      }
    };
    plain.on("data", onPlain);
    plain.on("error", () => undefined);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

/** A submission server: implicit TLS when `implicit`, otherwise cleartext with mandatory STARTTLS. */
function smtpServer(implicit: boolean, stored: string[]): Promise<net.Server> {
  const session = (sock: net.Socket | tls.TLSSocket, secured: boolean) => {
    let cur: net.Socket | tls.TLSSocket = sock; let buf = ""; let data: string[] | null = null;
    const w = (l: string) => cur.write(l + "\r\n");
    const bind = (s: net.Socket | tls.TLSSocket) => s.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      let nl: number;
      while ((nl = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        if (data) { if (line === ".") { stored.push(data.join("\n")); data = null; w("250 queued"); } else data.push(line); continue; }
        const v = line.split(" ")[0]!.toUpperCase();
        if (v === "EHLO") cur.write(`250-test\r\n${secured ? "250-AUTH PLAIN\r\n" : "250-STARTTLS\r\n"}250 8BITMIME\r\n`);
        else if (v === "STARTTLS") {
          w("220 go"); s.removeAllListeners("data");
          const t = new tls.TLSSocket(s as net.Socket, { isServer: true, key: creds.key, cert: creds.cert });
          t.on("error", () => undefined); secured = true; cur = t; bind(t); return;
        } else if (v === "AUTH") w("235 ok");
        else if (v === "MAIL" || v === "RCPT") w("250 ok");
        else if (v === "DATA") { data = []; w("354 go"); }
        else if (v === "QUIT") { w("221 bye"); cur.end(); }
        else w("502 no");
      }
    });
    bind(sock); w("220 test ESMTP");
  };
  const server = implicit
    ? tls.createServer({ key: creds.key, cert: creds.cert }, (s) => session(s, true))
    : net.createServer((s) => session(s, false));
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server as net.Server)));
}

/** A server that says go ahead to STARTTLS and never answers the handshake that follows. */
function stallingServer(): Promise<net.Server> {
  const server = net.createServer((plain) => {
    plain.write("* OK ready\r\n");
    plain.on("data", (d: Buffer) => { if (d.toString("latin1").includes("a1 STARTTLS\r\n")) plain.write("a1 OK begin TLS\r\n"); });
    plain.on("error", () => undefined);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const portOf = (s: net.Server) => (s.address() as net.AddressInfo).port;
const until = (label: string, ms: number, check: () => boolean) => new Promise<void>((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => { if (check()) return resolve(); if (Date.now() - t0 > ms) return reject(new Error(`${label}: not within ${ms} ms`)); setTimeout(tick, 10); };
  tick();
});

/** The upgrade's options, as the IMAP adapter passes its floor. */
const FLOOR = { host: "127.0.0.1", servername: "localhost", rejectUnauthorized: true, minVersion: "TLSv1.2" };
type Refused = Error & { code?: string; tlsFailed?: boolean; upgradeFailed?: boolean; certificateRefused?: boolean };

/** The plain half of imapflow's STARTTLS (`upgradeConnection`): greeting, go-ahead, parser detached and drained. */
async function plainToGoAhead(t: ReturnType<typeof loadTransport>, port: number) {
  const streamer = new PassThrough();
  let seen = "";
  streamer.on("data", (d: Buffer) => { seen += d.toString(); });
  const plain = t.net.connect({ host: "127.0.0.1", port });
  plain.pipe(streamer);
  await until("greeting", 2000, () => seen.includes("* OK ready"));
  plain.write("a1 STARTTLS\r\n");
  await until("STARTTLS answer", 2000, () => seen.includes("a1 OK"));
  plain.unpipe(streamer);
  plain.read();
  return plain;
}

describe("a STARTTLS session on the phone's transport", () => {
  for (const upgrade of ["android", "ios"] as const) {
    it(`${upgrade}: keeps flowing past 16 KiB after an imapflow-shaped upgrade`, async () => {
      const server = await imapServer();
      const t = loadTransport(false, { upgrade });
      try {
        const plain = await plainToGoAhead(t, portOf(server));
        const upgraded = new PassThrough();
        let secureSeen = "";
        upgraded.on("data", (d: Buffer) => { secureSeen += d.toString(); });
        const up = t.tls.connect({ socket: plain, ...FLOOR }, () => {
          up.pipe(upgraded);
          up.write("a2 FETCH\r\n");
        });
        await until("the answer past 16 KiB", 5000, () => secureSeen.includes("a2 OK"));
        up.write("a3 NOOP\r\n");
        await until("the next command's answer", 3000, () => secureSeen.includes("a3 OK"));
        expect(secureSeen.length).toBeGreaterThan(BIG);
        up.destroy();
      } finally { t.restore(); server.close(); }
    });
  }

  for (const upgrade of ["android", "ios"] as const) {
    it(`${upgrade}: bytes that arrive before the handshake is confirmed are never read, and refuse the upgrade`, async () => {
      const server = await imapServer();
      const t = loadTransport(false, { upgrade });
      try {
        const plain = await plainToGoAhead(t, portOf(server));
        let secured = false;
        let read = "";
        const errors: Refused[] = [];
        const up = t.tls.connect({ socket: plain, ...FLOOR }, () => { secured = true; });
        up.on("error", (e: Refused) => errors.push(e));
        up.on("data", (d: Buffer) => { read += d.toString(); });
        // What the receiver read between the go-ahead and the upgrade: never the server's (it waits for a ClientHello).
        deliverNative(t.conns[0]!, Buffer.from("a2 OK LOGIN completed\r\n"));
        await until("the refusal", 2000, () => errors.length > 0);
        await new Promise((r) => setTimeout(r, 100));
        expect(read, "the injected bytes reached the reader").toBe("");
        expect(errors).toHaveLength(1);
        expect(errors[0]!.code).toBe("STARTTLS_INJECTION");
        expect(errors[0]!.tlsFailed).toBe(true);
        expect(secured, "a refused upgrade reported itself secured").toBe(false);
      } finally { t.restore(); server.close(); }
    });
  }

  it("ios: a handshake that never ends is refused at the upgrade's deadline, by name, and not before", async () => {
    const server = await stallingServer();
    const t = loadTransport(false, { upgrade: "ios" });
    try {
      const plain = await plainToGoAhead(t, portOf(server));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const errors: Refused[] = [];
      const up = t.tls.connect({ socket: plain, ...FLOOR });
      up.on("error", (e: Refused) => errors.push(e));
      await vi.advanceTimersByTimeAsync(9_900);
      expect(errors, "refused before the upgrade's deadline").toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("UPGRADE_TIMEOUT");
      expect(errors[0]!.tlsFailed).toBe(true);
    } finally { vi.useRealTimers(); t.restore(); server.close(); }
  });

  for (const upgrade of ["android", "ios"] as const) {
    it(`${upgrade}: delivers a message over 587-style STARTTLS through nodemailer's own client`, async () => {
      const stored: string[] = [];
      const server = await smtpServer(false, stored);
      const t = loadTransport(true, { upgrade });
      try {
        const c = new t.SMTPConnection({ host: "127.0.0.1", port: portOf(server), secure: false, requireTLS: true, name: "phone.test", tls: { servername: "localhost", rejectUnauthorized: true, minVersion: "TLSv1.2" } });
        await new Promise<void>((resolve, reject) => { c.once("error", reject); c.connect(() => resolve()); });
        expect(c.secure).toBe(true);
        await new Promise<void>((resolve, reject) => c.login({ user: "u", pass: "p" }, (e: Error | null) => (e ? reject(e) : resolve())));
        await new Promise<void>((resolve, reject) => c.send({ from: "a@test.invalid", to: ["b@test.invalid"] }, "Subject: t\r\n\r\nbody\r\n", (e: Error | null) => (e ? reject(e) : resolve())));
        c.quit();
        expect(stored).toHaveLength(1);
      } finally { t.restore(); server.close(); }
    });
  }

  it("the 465 control: an implicit-TLS session delivers on the same double", async () => {
    const stored: string[] = [];
    const server = await smtpServer(true, stored);
    const t = loadTransport(true);
    try {
      const c = new t.SMTPConnection({ host: "127.0.0.1", port: portOf(server), secure: true, name: "phone.test", tls: { servername: "localhost", rejectUnauthorized: true, minVersion: "TLSv1.2" } });
      await new Promise<void>((resolve, reject) => { c.once("error", reject); c.connect(() => resolve()); });
      await new Promise<void>((resolve, reject) => c.login({ user: "u", pass: "p" }, (e: Error | null) => (e ? reject(e) : resolve())));
      await new Promise<void>((resolve, reject) => c.send({ from: "a@test.invalid", to: ["b@test.invalid"] }, "Subject: t\r\n\r\nbody\r\n", (e: Error | null) => (e ? reject(e) : resolve())));
      c.quit();
      expect(stored).toHaveLength(1);
    } finally { t.restore(); server.close(); }
  });

  it("refuses an upgrade that never finishes, by name and within its bound, flagged tlsFailed", async () => {
    const t = loadTransport();
    try {
      const lines: Array<{ event: string; outcome?: string }> = [];
      t.net.setSocketLog((event: string, f: { outcome?: string }) => lines.push({ event, ...f }));
      const bridge = new (req(join(SHIMS, "net.js")).NativeSocketBridge)({ on: () => undefined, getPeerCertificate: () => new Promise(() => undefined) });
      const errors: Array<Error & { tlsFailed?: boolean }> = [];
      bridge.on("error", (e: Error) => errors.push(e));
      t.tls.superviseUpgrade({ getPeerCertificate: () => new Promise(() => undefined) }, bridge, 50);
      await until("the bound's refusal", 1000, () => errors.length === 1);
      expect(errors[0]!.tlsFailed).toBe(true);
      expect(errors[0]!.message).toMatch(/did not finish within 50 ms/);
      expect(lines.filter((l) => l.event === "tls_upgrade_settled").map((l) => l.outcome)).toEqual(["refused"]);
    } finally { t.restore(); }
  });
});

/**
 * A REFUSED UPGRADE SAYS IT WAS THE UPGRADE THAT FAILED. Before, every such refusal read as a server
 * that offers no encryption: Android's own injection refusal (transport patch §5) lost its kind, and
 * an iOS handshake that broke off was told "try another port" with no word of the switch failing.
 */
describe("a refused upgrade, in each platform's words", () => {
  const INJECTED = "plaintext arrived after the STARTTLS command and would be read as though it came from the encrypted session";
  const cases = [
    ["android", `the TLS upgrade failed: java.io.IOException: refusing the TLS upgrade: ${INJECTED}`, "STARTTLS_INJECTION"],
    ["ios", `the TLS upgrade failed: refusing the TLS upgrade: ${INJECTED}`, "STARTTLS_INJECTION"],
    ["ios", "The operation couldn’t be completed. (kCFStreamErrorDomainSSL error -9806.)", undefined],
  ] as const;
  for (const [upgrade, words, code] of cases) {
    it(`${upgrade}: "${words.slice(0, 48)}…" is an upgrade failure${code ? `, ${code}` : ""}, and no certificate`, async () => {
      const server = await imapServer();
      const t = loadTransport(false, { upgrade, unregisterOnClose: true, refusedUpgrade: "error-first", say: () => words }, strangerCa);
      try {
        const plain = await plainToGoAhead(t, portOf(server));
        const errors: Refused[] = [];
        const up = t.tls.connect({ socket: plain, ...FLOOR });
        up.on("error", (e: Refused) => errors.push(e));
        await until("the refusal", 3000, () => errors.length > 0);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toBe(words);
        expect(errors[0]!.tlsFailed).toBe(true);
        expect(errors[0]!.upgradeFailed).toBe(true);
        expect(errors[0]!.code).toBe(code);
        expect(errors[0]!.certificateRefused).toBeUndefined();
      } finally { t.restore(); server.close(); }
    });
  }
});
