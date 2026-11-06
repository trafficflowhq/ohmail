/**
 * AN ERROR NOBODY LISTENS FOR NEVER CLOSES THE APP.
 *
 * On a device a TCP reset on a live STARTTLS session closed 0.25.8 three times in three: the
 * platform's TLS socket forwards every error to the PLAIN socket first (`TLSSocket._initialize`),
 * then to its own listeners, and the mail client keeps no `error` listener on either bridge once
 * it has upgraded and closed. The fakes below keep that order and the platform emitter's rule (an
 * unlistened `error` returns false, it does not throw); the bridges are node `events` and throw.
 */
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);

/** The platform socket: eventemitter3's rule, so an `error` with no listener is not a throw. */
class FakeNative extends EventEmitter {
  destroyed = false;
  /** A write the platform fails: its callback gets this Error, as a reset socket's does. */
  writeErr: string | null = null;
  cert: Promise<Record<string, unknown>> = Promise.resolve({ subject: { CN: "rig" } });
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error" && this.listenerCount("error") === 0) return false;
    return super.emit(event, ...args);
  }
  fail(what: unknown): void { this.emit("error", what); }
  getPeerCertificate(): Promise<Record<string, unknown>> { return this.cert; }
  destroy(): void { this.destroyed = true; }
  end(): void { /* nothing */ }
  pause(): void { /* nothing */ }
  resume(): void { /* nothing */ }
  write(_chunk: unknown, _encoding: unknown, cb?: (e?: Error) => void): boolean {
    const failed = this.writeErr;
    setTimeout(() => { if (cb) cb(failed ? new Error(failed) : undefined); }, 1);
    return true;
  }
}

/** The upgraded socket: forwards to the plain one BEFORE the shim attaches its own listener. */
class FakeTls extends FakeNative {
  constructor(readonly under: FakeNative) {
    super();
    this.on("error", (e) => { this.under.emit("error", e); });
  }
  override destroy(): void {
    this.destroyed = true;
    this.emit("close", true);
    this.under.emit("close", true);
  }
}

interface Bridge extends EventEmitter { native: FakeNative; destroyed: boolean }
interface NetShim { connect(o: unknown): Bridge; setSocketLog(l: (e: string, f: Record<string, unknown>) => void): void }
interface TlsShim { connect(o: unknown): Bridge; superviseUpgrade(n: FakeNative, b: Bridge, ms?: number): void }

const restore: Array<() => void> = [];
afterEach(() => { while (restore.length > 0) restore.pop()!(); });

const tlsNatives: FakeTls[] = [];
function loadShims(): { net: NetShim; tls: TlsShim } {
  const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "react-native-tcp-socket") {
      return {
        createConnection: () => new FakeNative(), connectTLS: () => new FakeNative(),
        TLSSocket: class { constructor(under: FakeNative) { const t = new FakeTls(under); tlsNatives.push(t); return t; } },
        isIP: () => 0, isIPv4: () => false, isIPv6: () => false,
      };
    }
    return original.call(this, request, parent, isMain);
  };
  restore.push(() => { Module._load = original; });
  const cache = (require_ as unknown as { cache: Record<string, unknown> }).cache;
  for (const key of Object.keys(cache)) if (key.includes("/engine/shims/")) delete cache[key];
  return { net: require_("../src/engine/shims/net.js") as NetShim, tls: require_("../src/engine/shims/tls.js") as TlsShim };
}

type Line = { event: string; fields: Record<string, unknown> };
async function upgraded(withLog = true): Promise<{ plain: Bridge; secured: Bridge; native: FakeTls; lines: Line[] }> {
  const { net, tls } = loadShims();
  const lines: Line[] = [];
  if (withLog) net.setSocketLog((event, fields) => { lines.push({ event, fields }); });
  const plain = net.connect({ host: "imap.example.invalid", port: 143 });
  const secured = tls.connect({ socket: plain, servername: "imap.example.invalid" });
  await new Promise<void>((resolve) => { secured.once("secureConnect", () => resolve()); });
  return { plain, secured, native: tlsNatives[tlsNatives.length - 1]!, lines };
}

describe("an error after the upgrade, with the mail client's listeners gone", () => {
  it("is said once, from the TLS bridge, with its errno, and closes both bridges", async () => {
    const { plain, secured, native, lines } = await upgraded();
    plain.removeAllListeners("error");
    secured.removeAllListeners("error");
    expect(() => native.fail("Broken pipe"), "the error reached the top of the app").not.toThrow();
    const said = lines.filter((l) => l.event === "socket_error_unlistened");
    expect(said).toHaveLength(1);
    expect((said[0]!.fields.err as Error & { code?: string }).code).toBe("EPIPE");
    expect(secured.destroyed).toBe(true);
    expect(plain.destroyed).toBe(true);
  });

  it("a write the platform fails after the reset is logged, not thrown, and closes the bridge", async () => {
    const { plain, secured, native, lines } = await upgraded();
    plain.removeAllListeners("error");
    secured.removeAllListeners("error");
    const thrown: unknown[] = [];
    const onThrow = (e: unknown): void => { thrown.push(e); };
    process.on("uncaughtException", onThrow);
    restore.push(() => { process.off("uncaughtException", onThrow); });
    native.writeErr = "Broken pipe";
    (secured as unknown as { write(chunk: string): boolean }).write("A" + "1 NOOP\r\n");
    await new Promise((r) => setTimeout(r, 30));
    expect(thrown, "the failed write reached the top of the app").toHaveLength(0);
    expect(lines.filter((l) => l.event === "socket_error_unlistened")).toHaveLength(1);
    expect(secured.destroyed).toBe(true);
  });

  it("with no log wired, is still not a throw", async () => {
    const { plain, secured, native } = await upgraded(false);
    plain.removeAllListeners("error");
    secured.removeAllListeners("error");
    expect(() => native.fail("Connection reset by peer")).not.toThrow();
    expect(secured.destroyed).toBe(true);
  });

  it("reaches a listener the TLS bridge has, unchanged, and the plain side says nothing", async () => {
    const { plain, secured, native, lines } = await upgraded();
    const got: unknown[] = [];
    const plainGot: unknown[] = [];
    secured.on("error", (e) => { got.push(e); });
    plain.on("error", (e) => { plainGot.push(e); });
    native.fail("Broken pipe");
    expect(got).toHaveLength(1);
    expect(got[0]).toBeInstanceOf(Error);
    expect((got[0] as Error & { code?: string }).code).toBe("EPIPE");
    expect(plainGot, "the plain bridge re-emitted an error the TLS bridge carries").toHaveLength(0);
    expect(lines.filter((l) => l.event === "socket_error_unlistened")).toHaveLength(0);
  });
});

describe("the handshake window", () => {
  it("a certificate refusal settles once, through the TLS bridge, named", () => {
    const { net, tls } = loadShims();
    const plain = net.connect({ host: "imap.example.invalid", port: 143 });
    const secured = tls.connect({ socket: plain, servername: "imap.example.invalid" });
    const native = tlsNatives[tlsNatives.length - 1]!;
    native.cert = new Promise(() => undefined);
    const tlsErr: Array<Error & { tlsFailed?: boolean; certificateRefused?: boolean }> = [];
    const plainErr: unknown[] = [];
    secured.once("error", (e) => { tlsErr.push(e); });
    plain.once("error", (e) => { plainErr.push(e); });
    native.fail("java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.");
    expect(tlsErr).toHaveLength(1);
    expect(tlsErr[0]!.tlsFailed).toBe(true);
    expect(tlsErr[0]!.certificateRefused).toBe(true);
    expect(plainErr).toHaveLength(0);
  });

  it("an upgrade with no certificate to show, on a bridge nobody listens to, ends at the deadline: logged, not thrown", async () => {
    const { net, tls } = loadShims();
    const lines: Line[] = [];
    net.setSocketLog((event, fields) => { lines.push({ event, fields }); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    restore.push(() => { vi.useRealTimers(); });
    const plain = net.connect({ host: "imap.example.invalid", port: 143 });
    const secured = tls.connect({ socket: plain, servername: "imap.example.invalid" });
    tlsNatives[tlsNatives.length - 1]!.cert = Promise.resolve({});
    secured.removeAllListeners("error");
    await vi.advanceTimersByTimeAsync(9_900);
    expect(lines.filter((l) => l.event === "socket_error_unlistened"), "a verdict before the deadline").toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    const said = lines.filter((l) => l.event === "socket_error_unlistened");
    expect(said).toHaveLength(1);
    expect((said[0]!.fields.err as Error & { code?: string }).code).toBe("UPGRADE_TIMEOUT");
    expect(secured.destroyed).toBe(true);
  });

  it("the upgrade deadline on a bridge nobody listens to is logged, not thrown", async () => {
    const { net, tls } = loadShims();
    const lines: Line[] = [];
    net.setSocketLog((event, fields) => { lines.push({ event, fields }); });
    const bridge = net.connect({ host: "imap.example.invalid", port: 143 });
    bridge.native.cert = new Promise(() => undefined);
    tls.superviseUpgrade(bridge.native, bridge, 20);
    await new Promise((r) => setTimeout(r, 80));
    expect(lines.filter((l) => l.event === "socket_error_unlistened")).toHaveLength(1);
    expect(bridge.destroyed).toBe(true);
  });
});
