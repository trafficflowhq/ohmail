/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE FOURTH DOOR SAYS WHY A DIAL FAILED — over the ARTIFACT, against a server that refuses
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on a release build on a device before this existed: the credential form was filled
 * correctly, Connect was pressed, the mail server refused the dial at every attempt — and the door
 * answered `ok`, the screen navigated away, and for sixty seconds nothing was authenticated and
 * nothing said so. The engine's launch is a `void` call inside the artifact and the sidecar settles
 * every mailbox with `allSettled`, so there was no path by which a refusal could reach the person
 * holding the phone.
 *
 * ── WHY THESE CASES GO THROUGH THE ARTIFACT AND A REAL SOCKET ─────────────────────────────
 *
 * The refusal crosses three boundaries: imapflow stamps a flag, the engine's launch classifies it
 * and rethrows, the door turns it into a keyed sentence. A double at any one of them would test the
 * two either side of it and nothing about the seam. So the engine here is the packaged file the app
 * requires, the server is a listener this file owns, and the only thing standing in is the pair of
 * native modules the bundle leaves external.
 *
 * ── AND `0.0.0.0` IS WHY THE ENCRYPTION CASE IS REACHABLE AT ALL ──────────────────────────
 *
 * The TLS floor exempts loopback, so a plaintext dial to `127.0.0.1` is permitted and reaches
 * LOGIN — which is the device's OTHER arm, over `adb reverse`. `0.0.0.0` is the one address that is
 * both un-exempt and locally reachable (`imap.tls-floor.test.ts` establishes this), so it produces
 * the option bag a phone assembles for a real host: `doSTARTTLS`, and imapflow's own
 * `Server does not support STARTTLS` when the server offers none. That is byte-for-byte the shape
 * the device produced against `10.0.2.2` — the first divergence between the two runs was the host
 * string and nothing else.
 */
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
/* A certificate no authority vouches for, from the sidecar's own minting (lan-pairing-tls.test.ts). */
import { ensureLanIdentity } from "../../sidecar/src/host-lan-tls.js";

import { BUNDLE, buildPhoneEngine } from "../scripts/bundle-engine.mjs";
import { openStandaloneMailbox } from "../src/engine/standalone-door";
import { EMPTY_STANDALONE, type StandaloneFields } from "../src/ui/standalone-form";
import { sayRefusal } from "../src/refusal";

const require_ = createRequire(import.meta.url);
const sqlite = require_("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void; close(): void;
    prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown; columns?(): { column?: string | null; name?: string }[] };
  };
};

/** The password the form carries. Asserted ABSENT from every refusal this file produces. */
const PASSWORD = "not-the-one-the-server-wants-password-password";

/** The two native modules the bundle leaves external, and nothing else — see the banner. */
function loadArtifact(): Record<string, unknown> {
  const Module = require_("node:module") as { _load(r: string, p: unknown, m: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "react-native-tcp-socket") {
      const net = require_("node:net") as Record<string, unknown>;
      const tls = require_("node:tls") as Record<string, unknown>;
      return { createConnection: net.createConnection, connectTLS: tls.connect, TLSSocket: tls.TLSSocket,
               isIP: net.isIP, isIPv4: net.isIPv4, isIPv6: net.isIPv6 };
    }
    if (request === "react-native-quick-crypto") return require_("node:crypto");
    return original.call(this, request, parent, isMain);
  };
  try { return require_(BUNDLE) as Record<string, unknown>; } finally { Module._load = original; }
}

interface Store { exec: Record<string, unknown>; closed(): number }

/** `node:sqlite` behind the statement-runner contract, counting its own closes — see the stop assertion. */
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
        return { columns, rows: columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o)) };
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

interface Fake { port: number; lines: string[]; connections(): number; close(): Promise<void> }

/**
 * A loopback IMAP server whose ONE job is to answer the two ways a real server refuses.
 *
 * `startTls: "advertise"` is deliberately absent: the encryption case needs a server that offers
 * none, which is the whole of what makes `doSTARTTLS` fail. `acceptLogin` is the positive control.
 */
function fakeImap(o: { acceptLogin?: boolean } = {}): Promise<Fake> {
  const lines: string[] = [];
  const live = new Set<Socket>();
  let connections = 0;
  const srv = createServer((sock) => {
    connections += 1;
    live.add(sock);
    sock.on("error", () => { /* a client hanging up mid-refusal is the normal case here */ });
    sock.on("close", () => live.delete(sock));
    const write = (s: string): void => { if (!sock.destroyed) sock.write(s); };
    let buf = "";
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        lines.push(line);
        const [tag, cmd, ...args] = line.split(" ");
        const c = (cmd ?? "").toUpperCase();
        if (c === "CAPABILITY") write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        else if (c === "LOGIN") write(o.acceptLogin ? `${tag} OK logged in\r\n` : `${tag} NO the server refuses this password\r\n`);
        // imapflow's delimiter probe. It must answer with the delimiter alone, or the folder it
        // names becomes the namespace prefix of every later LIST.
        else if (c === "LIST" && args.join(" ") === `"" ""`) write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
        else if (c === "LIST") write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
        else if (c === "LSUB") write(`${tag} OK done\r\n`);
        else if (c === "LOGOUT") write(`* BYE\r\n${tag} OK\r\n`);
        else write(`${tag} NO unsupported here\r\n`);
      }
    });
    write("* OK fake imap ready\r\n");
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      port: (srv.address() as { port: number }).port,
      lines,
      connections: () => connections,
      close: () => new Promise<void>((res) => { for (const s of live) s.destroy(); srv.close(() => res()); }),
    }));
  });
}

interface FakeTls { port: number; handshakes(): number; imapBytes(): number; close(): Promise<void> }

/** An implicit-TLS listener under a self-signed certificate. It counts what gets through. */
function fakeTlsImap(): Promise<FakeTls> {
  const id = ensureLanIdentity(mkdtempSync(join(tmpdir(), "ohmail-cert-refusal-")));
  if (id.kind !== "identity") throw new Error("the fixture certificate could not be minted");
  let handshakes = 0;
  let bytes = 0;
  const raw = new Set<Socket>();
  const srv = createTlsServer({ key: id.identity.key, cert: id.identity.cert }, (sock) => {
    sock.on("error", () => undefined);
    sock.on("data", (d: Buffer) => { bytes += d.length; });
    sock.write("* OK tls imap ready\r\n");
  });
  srv.on("connection", (sock: Socket) => { handshakes += 1; raw.add(sock); sock.on("close", () => raw.delete(sock)); });
  srv.on("tlsClientError", () => undefined);
  return new Promise((resolve) => {
    srv.listen(0, "0.0.0.0", () => resolve({
      port: (srv.address() as { port: number }).port,
      handshakes: () => handshakes,
      imapBytes: () => bytes,
      close: () => new Promise<void>((res) => { for (const r of raw) r.destroy(); srv.close(() => res()); }),
    }));
  });
}

const closers: Array<() => Promise<void>> = [];
let live: { stop(): Promise<void> } | null = null;
afterEach(async () => {
  if (live) await live.stop().catch(() => undefined);
  live = null;
  for (const c of closers.splice(0)) await c();
});

function fields(host: string, port: number): StandaloneFields {
  return { ...EMPTY_STANDALONE, address: "someone@example.test", password: PASSWORD,
           imapHost: host, imapPort: String(port), imapTls: false };
}

/** The door, driven exactly as `app/standalone.tsx` drives it. `lines` collects the engine's log. */
async function press(
  host: string, port: number, s: Store, o: { implicitTls?: boolean; lines?: string[] } = {},
): ReturnType<typeof openStandaloneMailbox> {
  await buildPhoneEngine();
  const mod = loadArtifact();
  const start = mod.startPhoneEngine as (cfg: { imap: Record<string, unknown> }) => Promise<unknown>;
  return openStandaloneMailbox(fields(host, port), {
    /* A random port cannot say "implicit TLS" the way 993 does, so the case asks for it. */
    startEngine: (o.implicitTls
      ? (cfg: { imap: Record<string, unknown> }) => start({ ...cfg, imap: { ...cfg.imap, secure: true } })
      : start) as never,
    platform: async () => ({ kind: "ready" as const, exec: s.exec, keks: { 1: "a".repeat(64) } }),
    machineName: () => "ohmail on a phone",
    installId: async () => "refusal-case",
    ...(o.lines !== undefined ? { logSink: (line: string) => { o.lines!.push(line); } } : {}),
  });
}

describe("the fourth door, when the mail server says no", () => {
  it("REFUSES a rejected sign-in, names the password, and keeps the password out of the sentence", async () => {
    const fake = await fakeImap();
    closers.push(fake.close);
    const s = store();
    const outcome = await press("127.0.0.1", fake.port, s);

    // The wire is the premise: without a LOGIN on it this case would pass for a dial that never
    // happened, which is the exact false green the device run looked like.
    expect(fake.lines.some((l) => / LOGIN /i.test(l)), "the credentials reached the wire").toBe(true);
    expect(outcome.ok, "the door does not report an opened mailbox").toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason.say).toBe("standaloneSignInRefused");
    // The sentence is about the password, and does not CONTAIN it. Rendered, because a key with an
    // argument would leak through the render and not through the value.
    expect(sayRefusal(outcome.reason)).not.toContain(PASSWORD);
    expect(JSON.stringify(outcome.reason)).not.toContain(PASSWORD);
    // NO ENGINE IS HANDED BACK, and this is the half a `{ ok: false }` alone does not prove: the
    // store this launch opened is closed, which only `sidecar.stop()` does.
    expect(s.closed(), "the refused launch let go of the store").toBeGreaterThan(0);
  }, 60_000);

  it("REFUSES a server with no encrypted way in — the shape a device produced against a real host", async () => {
    const fake = await fakeImap({ acceptLogin: true });
    closers.push(fake.close);
    const s = store();
    // `0.0.0.0`: un-exempt by the TLS floor, locally reachable. See the banner.
    const outcome = await press("0.0.0.0", fake.port, s);

    // The premise, and the whole point of this case: the password must NOT have reached the wire.
    // A floor that let it through would be a worse defect than the silence this file closes.
    expect(fake.lines.some((l) => / LOGIN /i.test(l)), "no password was sent in the clear").toBe(false);
    expect(fake.lines.some((l) => /CAPABILITY/i.test(l)), "the dial did reach the server").toBe(true);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason.say).toBe("standaloneNoEncryption");
    expect(s.closed(), "the refused launch let go of the store").toBeGreaterThan(0);
  }, 60_000);

  it("ADMITS the ordinary case: a server that accepts the login opens the mailbox", async () => {
    const fake = await fakeImap({ acceptLogin: true });
    closers.push(fake.close);
    const s = store();
    const outcome = await press("127.0.0.1", fake.port, s);

    expect(outcome.ok, "a server that logs us in is not a refusal").toBe(true);
    if (!outcome.ok) return;
    live = outcome.door as unknown as { stop(): Promise<void> };
    const res = await (outcome.door as unknown as { handle(r: Request): Promise<Response>; sessionToken: string })
      .handle(new Request("http://sidecar/hello", {
        headers: { authorization: `Bearer ${(outcome.door as unknown as { sessionToken: string }).sessionToken}` },
      }));
    expect(res.status, "the engine that was handed back answers its door").toBe(200);
    expect(s.closed(), "a healthy launch keeps its store").toBe(0);
  }, 60_000);

  it("REFUSES a certificate this phone will not accept — named, and before the password", async () => {
    /* Implicit TLS against a self-signed certificate: the platform refuses the handshake, the
       shim names it, and the door says the certificate rather than opening a mailbox that then
       reads "Connection lost. Reconnecting…" for ever. */
    const tls = await fakeTlsImap();
    closers.push(tls.close);
    const s = store();
    // `0.0.0.0` again: loopback is exempt from the floor and would not check the certificate.
    const outcome = await press("0.0.0.0", tls.port, s, { implicitTls: true });

    expect(tls.handshakes(), "the dial reached the server").toBeGreaterThan(0);
    expect(tls.imapBytes(), "nothing, and so no password, crossed the refused handshake").toBe(0);
    expect(outcome.ok, "the door does not report an opened mailbox").toBe(false);
    if (outcome.ok) return;
    /* Self-signed, which neither platform tells apart from an unknown authority: the desktop's
       "not issued by a trusted authority". */
    expect(outcome.reason.say).toBe("standaloneCertificateUntrusted");
    expect(sayRefusal(outcome.reason)).not.toContain(PASSWORD);
    expect(s.closed(), "the refused launch let go of the store").toBeGreaterThan(0);
  }, 60_000);

  it("REFUSES an incoming server nothing answers on: named, the seal discarded, the store let go", async () => {
    /* A port nothing is on. Connect opens a mailbox only over a login, as the desktop's does: an
       engine handed back here was an Ohbox saying "Reconnecting…" about a mailbox that never
       opened. The sentence names the address and port, never the password, and is
       not the sign-in's — a train tunnel must not read as a wrong password. The relaunch still
       opens over an outage (`phone-submission-at-connect.test.ts`). */
    const fake = await fakeImap();
    const port = fake.port;
    await fake.close();
    const s = store();
    const lines: string[] = [];
    const outcome = await press("127.0.0.1", port, s, { lines });

    if (outcome.ok) live = outcome.door as unknown as { stop(): Promise<void> };
    expect(outcome.ok, "an unreachable server opened a mailbox").toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason.say).toBe("standaloneImapUnreachable");
    expect(sayRefusal(outcome.reason)).not.toContain(PASSWORD);
    expect(JSON.stringify(outcome.reason)).not.toContain(PASSWORD);
    expect(lines.some((l) => l.includes("mailbox_open_unreachable"))).toBe(true);
    expect(lines.some((l) => l.includes("mailbox_open_seal_discarded")), "the password it sealed was kept").toBe(true);
    expect(lines.join("\n"), "the password reached the log").not.toContain(PASSWORD);
    expect(s.closed(), "the refused launch let go of the store").toBeGreaterThan(0);
  }, 60_000);
});
