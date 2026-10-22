/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PHONE'S CONNECT SAYS THE CERTIFICATE — over the ARTIFACT, on the phone's transport
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on the 0.28.0 release APK: against a STARTTLS server whose certificate
 * the phone refuses (a private-CA Dovecot on 143, reached over `adb reverse`), Connect passed, the
 * phone went on to the Ohbox, and the Ohbox said "Connection lost. Reconnecting…" while the server
 * logged eight refused handshakes and no login. Two of two, after a `pm clear`.
 *
 * Here the engine is the packaged file the app requires, the transport is the real shims over the
 * platform double (the library's unregister-on-close, the reason arriving before the close), the
 * scheduler is React Native's microtask `setImmediate`, and the server is a listener this file owns.
 * `127.0.0.1` is the device run's shape; `0.0.0.0` is the TLS floor's (`standalone-dial-refusal.test.ts`).
 *
 * And on implicit TLS (993, the form's default), where Android's module reports a refused handshake
 * by its message alone: for an expired or not-yet-valid certificate under a trusted root that is
 * "Chain validation failed", which Connect said was an unreachable server, and a connected mailbox
 * re-dialled for ever. The form says 993 there; the double dials this file's listener for it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BUNDLE, buildPhoneEngine } from "../scripts/bundle-engine.mjs";
import { forgetOrganizerSessionForTests, holdStandaloneDoor, standaloneHere } from "../src/engine/organizer-session";
import { openStandaloneMailbox, type StandaloneEngine } from "../src/engine/standalone-door";
import { DE } from "../src/copy.de";
import { EN } from "../src/copy.en";
import { resetLocaleRegisterForTests, setActiveLocale } from "../src/i18n/locale";
import { sayRefusal } from "../src/refusal";
import { connectionSay, topLineSaid } from "../src/state/live";
import { EMPTY_STANDALONE, type StandaloneFields } from "../src/ui/standalone-form";
import { platformDouble, type DoubleOptions } from "./_platform-socket-double";

const require_ = createRequire(import.meta.url);
const sqlite = require_("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void; close(): void;
    prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown; columns?(): { column?: string | null; name?: string }[] };
  };
};

/** The password the form carries. Asserted ABSENT from every refusal this file produces. */
const PASSWORD = "starttls-certificate-password-password";
/** What Android says once the transport carries the reason on the close (`patches/README.md` §5). */
const ANDROID = "the TLS upgrade failed: javax.net.ssl.SSLHandshakeException: "
  + "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.";
/** Android's implicit-TLS refusals: the module's message alone, and the patched transport's line. */
const CHAIN = "Chain validation failed";
const DIAL_EXPIRED = "the TLS handshake failed: javax.net.ssl.SSLHandshakeException: Chain validation failed; "
  + "caused by java.security.cert.CertificateException: Chain validation failed; "
  + "caused by java.security.cert.CertPathValidatorException: timestamp check failed; "
  + "caused by java.security.cert.CertificateExpiredException: Certificate expired at Thu Jan 02 00:00:00 GMT 2020";
const DIAL_NOT_YET_VALID = "the TLS handshake failed: javax.net.ssl.SSLHandshakeException: Chain validation failed; "
  + "caused by java.security.cert.CertificateException: Chain validation failed; "
  + "caused by java.security.cert.CertPathValidatorException: timestamp check failed; "
  + "caused by java.security.cert.CertificateNotYetValidException: Certificate not valid until Fri Jan 01 00:00:00 GMT 2049";
const DIAL_UNTRUSTED = "the TLS handshake failed: javax.net.ssl.SSLHandshakeException: "
  + "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.; "
  + "caused by java.security.cert.CertificateException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.; "
  + "caused by java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.";

let dir = "";
let phoneTrust = "";
let untrusted: Identity;
let trusted: Identity;
let expired: Identity;
let notYetValid: Identity;
interface Identity { key: Buffer; cert: Buffer }
const platform: DoubleOptions = { unregisterOnClose: true, refusedUpgrade: "error-first", say: () => ANDROID };
/** The listener that answers a dial to 993. */
let implicitPort: number | null = null;
let artifact: Record<string, unknown> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "starttls-certificate-"));
  const o = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "ignore" });
  const leaf = (name: string, ca: string): Identity => {
    o("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", "/CN=localhost");
    writeFileSync(join(dir, `${name}.ext`), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
    o("x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.pem`, "-CAkey", `${ca}.key`, "-CAcreateserial",
      "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`);
    return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) };
  };
  /* A leaf valid only between two dates: `openssl ca` takes both on every openssl; `x509` takes a
     day count, and not every openssl a negative one. */
  const dated = (name: string, ca: string, start: string, end: string): Identity => {
    o("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", "/CN=localhost");
    writeFileSync(join(dir, `${name}.ext`), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
    writeFileSync(join(dir, `${name}.db`), "");
    writeFileSync(join(dir, `${name}.srl`), "01\n");
    writeFileSync(join(dir, `${name}.cnf`), `[ca]\ndefault_ca = dated\n[dated]\ndatabase = ${name}.db\n`
      + `new_certs_dir = .\nserial = ${name}.srl\ndefault_md = sha256\npolicy = any\n[any]\ncommonName = supplied\n`);
    o("ca", "-batch", "-notext", "-config", `${name}.cnf`, "-cert", `${ca}.pem`, "-keyfile", `${ca}.key`, "-in", `${name}.csr`,
      "-out", `${name}.pem`, "-startdate", start, "-enddate", end, "-extfile", `${name}.ext`);
    return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) };
  };
  o("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "private.key", "-out", "private.pem", "-days", "2", "-subj", "/CN=a private CA");
  o("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "public.key", "-out", "public.pem", "-days", "2", "-subj", "/CN=the phone's trust");
  untrusted = leaf("untrusted", "private");
  trusted = leaf("trusted", "public");
  expired = dated("expired", "public", "200101000000Z", "200102000000Z");
  notYetValid = dated("not-yet-valid", "public", "490101000000Z", "491231000000Z");
  phoneTrust = readFileSync(join(dir, "public.pem"), "utf8");
  await buildPhoneEngine();
}, 180_000);
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** The packaged engine, with the two native modules it leaves external answered here. */
function loadArtifact(): Record<string, unknown> {
  if (artifact !== null) return artifact;
  const double = platformDouble(phoneTrust, platform);
  const mod = double.module as { connectTLS: (o: { port: number }) => unknown };
  const dial = mod.connectTLS;
  mod.connectTLS = (o) => dial(o.port === 993 && implicitPort !== null ? { ...o, port: implicitPort } : o);
  const Module = require_("node:module") as { _load(r: string, p: unknown, m: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "react-native-tcp-socket") return double.module;
    if (request === "react-native-quick-crypto") return require_("node:crypto");
    return original.call(this, request, parent, isMain);
  };
  try { artifact = require_(BUNDLE) as Record<string, unknown>; } finally { Module._load = original; }
  return artifact;
}

interface Store { exec: Record<string, unknown>; closed(): number }

/** `node:sqlite` behind the statement-runner contract, counting its own closes. */
function store(): Store {
  const raw = new sqlite.DatabaseSync(":memory:");
  let closed = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T,>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job); tail = next.catch(() => undefined); return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    closed: () => closed,
    exec: {
      all: (sql: string, params: readonly unknown[]) => serial(async () => {
        await yielded();
        const st = raw.prepare(sql);
        const columns = (st.columns?.() ?? []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
        return { columns, rows: columns.length > 0 ? objects.map((x) => columns.map((c) => x[c])) : objects.map((x) => Object.values(x)) };
      }),
      run: (sql: string, params: readonly unknown[]) => serial(async () => { await yielded(); raw.prepare(sql).run(...(params as unknown[])); }),
      batch: (sts: readonly { sql: string; params?: readonly unknown[] }[]) => serial(async () => {
        await yielded(); raw.exec("BEGIN IMMEDIATE");
        try { for (const { sql, params = [] } of sts) raw.prepare(sql).run(...(params as unknown[])); raw.exec("COMMIT"); }
        catch (e) { try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ } throw e; }
      }),
      close: async () => { closed += 1; try { raw.close(); } catch { /* already closed */ } },
    },
  };
}

interface Fake {
  port: number;
  /** What the server presents at its next STARTTLS — a certificate can change under a mailbox. */
  identity: Identity;
  logins(): number; upgrades(): number; connections(): number;
  /** Every connection, cut from the server's side. */
  drop(): void;
  close(): Promise<void>;
}

/**
 * IMAP on a plain port that upgrades with STARTTLS, or with the handshake first (`implicit`);
 * counts connections, upgrades and every LOGIN.
 */
function starttlsImap(identity: Identity, implicit = false): Promise<Fake> {
  let logins = 0;
  let upgrades = 0;
  let connections = 0;
  const live = new Set<net.Socket>();
  const fake = { identity } as Fake;
  const server = net.createServer((plain) => {
    connections += 1;
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
            const up = new tls.TLSSocket(sock, { isServer: true, key: fake.identity.key, cert: fake.identity.cert });
            up.on("error", () => undefined);
            session(up as unknown as net.Socket, true);
            return;
          } else if (c === "LOGIN" || c === "AUTHENTICATE") {
            logins += 1;
            write(secured ? `${tag} OK logged in\r\n` : `${tag} NO not over a plain connection\r\n`);
          }
          // imapflow's delimiter probe: the delimiter alone, or it becomes every LIST's prefix.
          else if (c === "LIST" && args.join(" ") === `"" ""`) write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
          else if (c === "LIST") write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
          else if (c === "LSUB") write(`${tag} OK done\r\n`);
          else if (c === "LOGOUT") write(`* BYE\r\n${tag} OK\r\n`);
          else write(`${tag} NO unsupported here\r\n`);
        }
      };
      sock.on("data", onData);
    };
    if (implicit) {
      const secure = new tls.TLSSocket(plain, { isServer: true, key: fake.identity.key, cert: fake.identity.cert });
      secure.on("error", () => undefined);
      secure.once("secure", () => {
        secure.write("* OK fake imaps ready\r\n");
        session(secure as unknown as net.Socket, true);
      });
      return;
    }
    plain.write("* OK fake imap ready\r\n");
    session(plain, false);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    Object.assign(fake, {
      port: (server.address() as net.AddressInfo).port,
      logins: () => logins,
      upgrades: () => upgrades,
      connections: () => connections,
      drop: () => { for (const s of live) s.destroy(); },
      close: () => new Promise<void>((done) => { for (const s of live) s.destroy(); server.close(() => done()); }),
    });
    resolve(fake);
  }));
}

/** React Native's `setImmediate` as bridgeless 0.86 installs it: a `queueMicrotask` shim. */
const nodeSetImmediate = globalThis.setImmediate;
function onThePhonesScheduler(): void {
  (globalThis as { setImmediate: unknown }).setImmediate = (cb: (...a: unknown[]) => void, ...args: unknown[]) => {
    globalThis.queueMicrotask(() => { cb.apply(undefined, args); });
    return 0;
  };
}

const closers: Array<() => Promise<void>> = [];
let live: { stop(): Promise<void> } | null = null;
afterEach(async () => {
  if (live) await live.stop().catch(() => undefined);
  live = null;
  forgetOrganizerSessionForTests();
  resetLocaleRegisterForTests();
  (globalThis as { setImmediate: unknown }).setImmediate = nodeSetImmediate;
  delete platform.refusedDial;
  implicitPort = null;
  for (const c of closers.splice(0)) await c();
});

function fields(host: string, port: number): StandaloneFields {
  return { ...EMPTY_STANDALONE, address: "someone@example.test", password: PASSWORD,
           imapHost: host, imapPort: String(port), imapTls: port === 993 };
}

/** The door, driven exactly as `app/standalone.tsx` drives it. */
function press(host: string, port: number, s: Store, lines: string[] = []): ReturnType<typeof openStandaloneMailbox> {
  const mod = loadArtifact();
  return openStandaloneMailbox(fields(host, port), {
    startEngine: mod.startPhoneEngine as never,
    platform: async () => ({ kind: "ready" as const, exec: s.exec, keks: { 1: "a".repeat(64) } }),
    machineName: () => "ohmail on a phone",
    installId: async () => "starttls-certificate-case",
    logSink: (line) => { lines.push(line); },
  });
}

const until = async (label: string, ms: number, check: () => boolean): Promise<void> => {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`${label}: not within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("Connect, against a STARTTLS server whose certificate this phone refuses", () => {
  for (const host of ["127.0.0.1", "0.0.0.0"]) {
    it(`REFUSES at ${host}, names the untrusted certificate, and sends no password`, async () => {
      const server = await starttlsImap(untrusted);
      closers.push(server.close);
      const s = store();
      onThePhonesScheduler();
      const outcome = await press(host, server.port, s);

      if (outcome.ok) live = outcome.door as unknown as { stop(): Promise<void> };
      expect(server.upgrades(), "the dial reached the server's upgrade").toBeGreaterThan(0);
      expect(server.logins(), "a password crossed a refused handshake").toBe(0);
      expect(outcome.ok, "the door reported an opened mailbox over a refused certificate").toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason.say).toBe("standaloneCertificateUntrusted");
      expect(sayRefusal(outcome.reason)).not.toContain(PASSWORD);
      expect(JSON.stringify(outcome.reason)).not.toContain(PASSWORD);
      expect(s.closed(), "the refused launch let go of the store").toBeGreaterThan(0);
    }, 90_000);
  }

  for (const host of ["127.0.0.1", "0.0.0.0"]) {
    it(`CONTROL — at ${host} a certificate this phone trusts upgrades, signs in, and opens the mailbox`, async () => {
      const server = await starttlsImap(trusted);
      closers.push(server.close);
      const s = store();
      onThePhonesScheduler();
      const outcome = await press(host, server.port, s);

      expect(outcome.ok, outcome.ok ? "" : sayRefusal(outcome.reason)).toBe(true);
      if (!outcome.ok) return;
      live = outcome.door as unknown as { stop(): Promise<void> };
      expect(server.logins(), "the sign-in happened, over the upgraded connection").toBeGreaterThan(0);
      expect(s.closed(), "a healthy launch keeps its store").toBe(0);
    }, 90_000);
  }
});

describe("a mailbox already open, when its server's certificate changes", () => {
  it("names the certificate in the Ohbox's line, in both languages, and stops re-dialling", async () => {
    const server = await starttlsImap(trusted);
    closers.push(server.close);
    const s = store();
    const lines: string[] = [];
    onThePhonesScheduler();
    const outcome = await press("127.0.0.1", server.port, s, lines);
    expect(outcome.ok, outcome.ok ? "" : sayRefusal(outcome.reason)).toBe(true);
    if (!outcome.ok) return;
    const door = outcome.door as StandaloneEngine & { wake(): Promise<void> };
    live = door;
    expect(holdStandaloneDoor(door)).toBe(true);
    const id = Object.keys(door.runtimes().connection)[0]!;

    /* The server now presents a certificate under a private authority, and the connection drops. */
    const signedIn = server.logins();
    expect(signedIn).toBeGreaterThan(0);
    server.identity = untrusted;
    server.drop();
    await until("the engine saw its connection end", 15_000, () => door.runtimes().connection[id]?.reachable === false);
    await door.wake();
    await until("the re-dial settled", 15_000, () => lines.some((l) => /mailbox_(certificate_check|reconnect)_failed/.test(l)));

    expect(server.logins(), "a password crossed the refused handshake").toBe(signedIn);
    expect(door.runtimes().connection[id]?.certificateRefused, "the refusal was read as an outage").toBe(true);
    expect(lines.some((l) => l.includes("mailbox_certificate_check_failed"))).toBe(true);

    /* Nothing re-dials it by itself: the wake the poll and the heartbeat take dials nothing now. */
    const dialled = server.connections();
    await door.wake();
    await new Promise((r) => setTimeout(r, 300));
    expect(server.connections(), "a refused certificate was dialled again").toBe(dialled);

    const said = () => topLineSaid({
      network: "online", connection: connectionSay(standaloneHere(), new Date(), "Europe/Zurich"),
      stale: null, draining: false, continuing: null,
    })?.text;
    setActiveLocale("en");
    expect(said()).toBe(EN.connectionCertificateRefused);
    setActiveLocale("de");
    expect(said()).toBe(DE.connectionCertificateRefused);
  }, 120_000);
});

describe("Connect on implicit TLS (993), when the platform refuses the server's certificate", () => {
  const cases: Array<[string, () => Identity, string, string]> = [
    ["an expired certificate, in the module's words alone", () => expired, CHAIN, "standaloneCertificateRefused"],
    ["an expired certificate, with the causes the patched transport says", () => expired, DIAL_EXPIRED, "standaloneCertificateExpired"],
    ["a certificate not valid yet, with its causes", () => notYetValid, DIAL_NOT_YET_VALID, "standaloneCertificateNotYetValid"],
    ["CONTROL — a private authority's certificate is still the untrusted one", () => untrusted, DIAL_UNTRUSTED, "standaloneCertificateUntrusted"],
  ];
  for (const [what, identity, words, say] of cases) {
    it(`REFUSES, names it, and sends no password: ${what}`, async () => {
      const server = await starttlsImap(identity(), true);
      closers.push(server.close);
      implicitPort = server.port;
      platform.refusedDial = () => words;
      const s = store();
      onThePhonesScheduler();
      const outcome = await press("127.0.0.1", 993, s);

      if (outcome.ok) live = outcome.door as unknown as { stop(): Promise<void> };
      expect(server.connections(), "the dial reached the server").toBeGreaterThan(0);
      expect(server.logins(), "a password crossed a refused handshake").toBe(0);
      expect(outcome.ok, "the door reported an opened mailbox over a refused certificate").toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason.say, "a refused certificate was said as an unreachable server").toBe(say);
      expect(sayRefusal(outcome.reason)).not.toContain(PASSWORD);
      expect(JSON.stringify(outcome.reason)).not.toContain(PASSWORD);
      expect(s.closed(), "the refused launch let go of the store").toBeGreaterThan(0);
    }, 90_000);
  }

  it("CONTROL — a certificate this phone trusts signs in and opens the mailbox", async () => {
    const server = await starttlsImap(trusted, true);
    closers.push(server.close);
    implicitPort = server.port;
    platform.refusedDial = () => CHAIN;
    const s = store();
    onThePhonesScheduler();
    const outcome = await press("127.0.0.1", 993, s);

    expect(outcome.ok, outcome.ok ? "" : sayRefusal(outcome.reason)).toBe(true);
    if (!outcome.ok) return;
    live = outcome.door as unknown as { stop(): Promise<void> };
    expect(server.logins(), "the sign-in happened").toBeGreaterThan(0);
    expect(s.closed(), "a healthy launch keeps its store").toBe(0);
  }, 90_000);
});

describe("a mailbox already open on implicit TLS, when its server's certificate expires", () => {
  for (const [how, words] of [["in the module's words alone", CHAIN], ["with the patched transport's causes", DIAL_EXPIRED]] as const) {
    it(`names the certificate in the Ohbox's line, in both languages, and stops re-dialling: ${how}`, async () => {
      const server = await starttlsImap(trusted, true);
      closers.push(server.close);
      implicitPort = server.port;
      platform.refusedDial = () => words;
      const s = store();
      const lines: string[] = [];
      onThePhonesScheduler();
      const outcome = await press("127.0.0.1", 993, s, lines);
      expect(outcome.ok, outcome.ok ? "" : sayRefusal(outcome.reason)).toBe(true);
      if (!outcome.ok) return;
      const door = outcome.door as StandaloneEngine & { wake(): Promise<void> };
      live = door;
      expect(holdStandaloneDoor(door)).toBe(true);
      const id = Object.keys(door.runtimes().connection)[0]!;

      const signedIn = server.logins();
      expect(signedIn).toBeGreaterThan(0);
      server.identity = expired;
      server.drop();
      await until("the engine saw its connection end", 15_000, () => door.runtimes().connection[id]?.reachable === false);
      await door.wake();
      await until("the re-dial settled", 15_000, () => lines.some((l) => /mailbox_(certificate_check|reconnect)_failed/.test(l)));

      expect(server.logins(), "a password crossed the refused handshake").toBe(signedIn);
      expect(door.runtimes().connection[id]?.certificateRefused, "the refusal was read as an outage").toBe(true);
      expect(lines.some((l) => l.includes("mailbox_certificate_check_failed"))).toBe(true);

      const dialled = server.connections();
      await door.wake();
      await new Promise((r) => setTimeout(r, 300));
      expect(server.connections(), "a refused certificate was dialled again").toBe(dialled);

      const said = () => topLineSaid({
        network: "online", connection: connectionSay(standaloneHere(), new Date(), "Europe/Zurich"),
        stale: null, draining: false, continuing: null,
      })?.text;
      setActiveLocale("en");
      expect(said()).toBe(EN.connectionCertificateRefused);
      setActiveLocale("de");
      expect(said()).toBe(DE.connectionCertificateRefused);
    }, 120_000);
  }
});
