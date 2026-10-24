/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A WRITE INTO A CLOSED CONNECTION IS REFUSED AT THE BRIDGE — and does not reach the top
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The mail client's queue writes in a MICROTASK: `trySend` dequeues a command and `send` awaits
 * its compiler twice before `write` puts bytes on the socket. A connection that dies inside that
 * window leaves a chunk addressed to a socket that is not there — measured as an uncaught
 * `ERR_STREAM_DESTROYED` out of `NativeSocketBridge._write`, after the tests, in the shipped
 * artifact.
 *
 * The bridge had mirrored the native socket's death into the READABLE side only (`push(null)`),
 * so `destroyed` answered false, the stream layer's own write-after-destroy guard never fired,
 * and the chunk was handed to the platform. What came back was then emitted as `error` at a
 * socket whose last `error` listener was a spent `once` — and an `error` nobody listens for is a
 * throw. On a phone there is nowhere for it to go at all: the artifact's `process` stand-in
 * registers no handlers, so the same sequence is an app crash in a release build.
 *
 * ── WHY BOTH FAKE PLATFORMS, AND WHY THEY THROW DIFFERENTLY ───────────────────────────────
 *
 * A double has to fail the way production fails. The two natives this bridge is ever built over
 * refuse a write after destroy in two different shapes, and a test carrying only one would prove
 * the guard for one platform:
 *
 *  · **the phone** — `react-native-tcp-socket`'s `Socket#write` THROWS `Socket is closed.`
 *    synchronously, with no code and no callback (`src/Socket.js:338`);
 *  · **Node**, which is what the bundle test's harness supplies — the write is accepted and the
 *    error arrives at the callback as `ERR_STREAM_DESTROYED`.
 *
 * Both are wired below, and the refusal has to hold over both. `NOT_REACHED` is the assertion
 * that decides: with the guard, neither native is ever asked.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import { arrived, CASE_MS } from "./helpers/arrived";
import { platformDouble } from "./_platform-socket-double";

const require_ = createRequire(import.meta.url);
const SHIM = "../src/engine/shims/net.js";
const TLS_SHIM = "../src/engine/shims/tls.js";

/** How a native refused the write, so a case can say which platform it is measuring. */
type Refusal = "throws" | "callback";

/**
 * ONE PLATFORM SOCKET, with the refusal shape named.
 *
 * `destroyed` is the field both natives expose and the one the bridge reads; `writes` counts what
 * actually reached the platform, which is the number the guard exists to hold at zero.
 */
class FakeNative extends EventEmitter {
  destroyed = false;
  writes = 0;
  /** Chunks the platform accepted — the positive control reads this. */
  readonly accepted: Buffer[] = [];
  ended = false;

  constructor(private readonly refusal: Refusal) { super(); }

  write(chunk: Buffer, _encoding: unknown, cb?: (err?: Error) => void): boolean {
    this.writes += 1;
    if (this.destroyed) {
      if (this.refusal === "throws") {
        // react-native-tcp-socket, verbatim in effect: no code, no callback, a bare throw.
        throw new Error("Socket is closed.");
      }
      const err = new Error("Cannot call write after a stream was destroyed") as Error & { code: string };
      err.code = "ERR_STREAM_DESTROYED";
      // Node delivers it on the next tick, never synchronously.
      process.nextTick(() => cb?.(err));
      return false;
    }
    this.accepted.push(chunk);
    process.nextTick(() => cb?.());
    return true;
  }

  /**
   * The platform answers this on a TLS socket, and the shim asks it to learn that a STARTTLS
   * upgrade finished — the platform emits no event for that. A double without it would make the
   * shim fail in a way production cannot.
   */
  getPeerCertificate(): Promise<Record<string, unknown>> {
    return Promise.resolve({ subject: { CN: "fixture.invalid" } });
  }

  /** The platform's own teardown. It does NOT emit `close` — that is the case the bundle met. */
  destroy(): void { this.destroyed = true; }
  end(): void { this.ended = true; }
  pause(): void { /* nothing buffered here */ }
  resume(): void { /* nothing buffered here */ }
  setKeepAlive(): this { return this; }
  setNoDelay(): this { return this; }
  setTimeout(): this { return this; }
  address(): unknown { return { address: "127.0.0.1", family: "IPv4", port: 993 }; }
}

interface Bridge extends EventEmitter {
  native: FakeNative;
  destroyed: boolean;
  write(chunk: Buffer, cb?: (err?: Error | null) => void): boolean;
  on(event: string, fn: (...a: unknown[]) => void): this;
}

interface Shim {
  connect(options: unknown, listener?: () => void): Bridge;
  setSocketLog(log: (event: string, detail: Record<string, unknown>) => void): void;
}

/**
 * Load the shim with the native package answered by {@link FakeNative}.
 *
 * The same `Module._load` interception `engine-bundle-loads.test.ts` uses for the artifact's two
 * externals, and the module cache is cleared so each case gets its own sink and its own bridge
 * class state.
 */
function loadShim(refusal: Refusal): { shim: Shim; tls: Shim; made: FakeNative[] } {
  const made: FakeNative[] = [];
  const Module = require_("node:module") as {
    _load(req: string, parent: unknown, isMain: boolean): unknown;
  };
  const original = Module._load;
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "react-native-tcp-socket") {
      const make = (): FakeNative => { const n = new FakeNative(refusal); made.push(n); return n; };
      return {
        createConnection: make,
        connectTLS: make,
        /* The upgrade route: `tls.connect({ socket })` builds its TLS socket over the EXISTING
           native. Counted like the others so a case can address it. */
        TLSSocket: class { constructor() { return make(); } },
        isIP: () => 0, isIPv4: () => false, isIPv6: () => false,
      };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    const cache = (require_ as unknown as { cache: Record<string, unknown> }).cache;
    for (const key of Object.keys(cache)) {
      if (key.includes("engine/shims/net.js") || key.includes("engine/shims/tls.js")) delete cache[key];
    }
    return {
      shim: require_(SHIM) as Shim,
      tls: require_(TLS_SHIM) as Shim,
      made,
    };
  } finally { Module._load = original; }
}

/** Every line the bridge wrote, through the one diagnostic the phone composition hands it. */
function withLog(shim: Shim): Array<{ event: string; detail: Record<string, unknown> }> {
  const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
  shim.setSocketLog((event, detail) => { lines.push({ event, detail }); });
  return lines;
}

/**
 * WHAT THE BRIDGE EMITTED, counted — and the count IS the product property.
 *
 * An `error` event with no listener is what throws, so "does the bridge emit here?" and "does
 * this reach the top?" are the same question asked twice. Attaching a counter answers it without
 * taking the process down with the case, and the child-process arm at the end of this file
 * proves the two readings agree.
 */
function watch(bridge: Bridge): { errors: unknown[]; closes: number } {
  const seen = { errors: [] as unknown[], closes: 0 };
  bridge.on("error", (err) => { seen.errors.push(err); });
  bridge.on("close", () => { seen.closes += 1; });
  return seen;
}

const CHUNK = Buffer.from("A" + "1 NOOP\r\n");
/**
 * An ordering hop, and the window an ABSENCE is read over (no `error`, no second `close`): an
 * absence cannot be waited for. What a case asserts ARRIVED is waited for, by name.
 */
const settle = (): Promise<void> => new Promise((r) => { setTimeout(r, 20); });
const NEVER = "the callback was never called";
const called = (read: () => unknown): Promise<void> => arrived("the write's callback", () => read() !== NEVER);

describe.each<Refusal>(["throws", "callback"])(
  "the phone's socket bridge, over a native that refuses a write by %s",
  (refusal) => {
    let shim: Shim;
    let tls: Shim;
    let lines: Array<{ event: string; detail: Record<string, unknown> }>;
    beforeEach(() => {
      const loaded = loadShim(refusal);
      shim = loaded.shim;
      tls = loaded.tls;
      lines = withLog(shim);
    });

    it("REFUSES a write after the connection closed, and the caller is the one told", async () => {
      const bridge = shim.connect({ host: "imap.invalid", port: 993 });
      const seen = watch(bridge);
      bridge.native.emit("connect");

      // The server hangs up. This is the ordinary outage, and the one the bundle test produces.
      bridge.native.destroy();
      bridge.native.emit("close", false);
      await settle();

      const writesBefore = bridge.native.writes;
      let handed: unknown = NEVER;
      bridge.write(CHUNK, (err) => { handed = err ?? null; });
      await called(() => handed);
      await settle();

      expect(
        bridge.native.writes - writesBefore,
        "the chunk was handed to the platform anyway — the refusal is not at this door",
      ).toBe(0);
      expect(handed, "the pending write's callback was not told why its bytes did not go")
        .toBeInstanceOf(Error);
      expect((handed as Error & { code?: string }).code).toBe("ERR_STREAM_DESTROYED");
      expect(
        seen.errors,
        "the bridge emitted `error` at a socket with no listener left, which is the uncaught throw",
      ).toHaveLength(0);
    }, CASE_MS);

    it("REFUSES it when the native was destroyed with NO close event — the measured shape", async () => {
      const bridge = shim.connect({ host: "imap.invalid", port: 993 });
      const seen = watch(bridge);
      bridge.native.emit("connect");

      /* The artifact's own case: the listener destroys the socket and nothing tells the bridge.
         `destroyed` on the native is then the only evidence there is. */
      bridge.native.destroy();
      await settle();

      let handed: unknown = NEVER;
      bridge.write(CHUNK, (err) => { handed = err ?? null; });
      await called(() => handed);
      await settle();

      expect(bridge.native.accepted, "the platform was asked to write into a destroyed socket")
        .toHaveLength(0);
      expect(handed, "the pending write's callback was not told").toBeInstanceOf(Error);
      expect(seen.errors, "the refusal became an unlistened `error` emit").toHaveLength(0);
    }, CASE_MS);

    it("WRITES ONE LINE for the refusal, naming the bytes and no content", async () => {
      const bridge = shim.connect({ host: "imap.invalid", port: 993 });
      watch(bridge);
      bridge.native.emit("connect");
      bridge.native.destroy();
      bridge.native.emit("close", false);
      await settle();

      bridge.write(CHUNK, () => undefined);
      bridge.write(CHUNK, () => undefined);
      await arrived("the refusal's line", () => lines.some((l) => l.event === "socket_write_after_close"));

      const refusals = lines.filter((l) => l.event === "socket_write_after_close");
      expect(
        refusals.length,
        "the refusal was silent — a dropped command with no line is the failure-looks-healthy shape",
      ).toBeGreaterThanOrEqual(1);
      expect(refusals[0]!.detail.bytes, "the line does not say how much was dropped")
        .toBe(CHUNK.length);
      /* THE CHUNK'S CONTENT IS NEVER ON THE LINE. A command carries a mailbox name and, on the
         one command that matters most, a password. */
      const rendered = JSON.stringify(refusals);
      expect(rendered, "the refused bytes were written into the log line").not.toContain("NOOP");
    }, CASE_MS);

    it("REFUSES on the TLS entry point too — one bridge, one door", async () => {
      const bridge = tls.connect({ host: "imap.invalid", port: 993 });
      const seen = watch(bridge);
      bridge.native.emit("secureConnect");
      bridge.native.destroy();
      bridge.native.emit("close", false);
      await settle();

      let handed: unknown = NEVER;
      bridge.write(CHUNK, (err) => { handed = err ?? null; });
      await called(() => handed);
      await settle();

      expect(bridge.native.accepted, "the TLS transport handed bytes to a destroyed socket")
        .toHaveLength(0);
      expect(handed, "the TLS transport's caller was not told").toBeInstanceOf(Error);
      expect(seen.errors, "the TLS transport emitted an unlistened `error`").toHaveLength(0);
    }, CASE_MS);

    it("REFUSES on a STARTTLS upgrade of an existing bridge", async () => {
      const plain = shim.connect({ host: "imap.invalid", port: 143 });
      plain.native.emit("connect");
      const upgraded = tls.connect({ host: "imap.invalid", port: 143, socket: plain });
      const seen = watch(upgraded);
      upgraded.native.destroy();
      upgraded.native.emit("close", false);
      await settle();

      let handed: unknown = NEVER;
      upgraded.write(CHUNK, (err) => { handed = err ?? null; });
      await called(() => handed);
      await settle();
      expect(handed, "the upgraded connection's caller was not told").toBeInstanceOf(Error);
      expect(seen.errors, "the upgraded connection emitted an unlistened `error`").toHaveLength(0);
    }, CASE_MS);

    it("CARRIES AN ORDINARY WRITE to the platform, and writes no line — the positive control", async () => {
      const bridge = shim.connect({ host: "imap.invalid", port: 993 });
      const seen = watch(bridge);
      bridge.native.emit("connect");

      let handed: unknown = NEVER;
      bridge.write(CHUNK, (err) => { handed = err ?? null; });
      await called(() => handed);
      await settle();

      expect(bridge.native.accepted, "a healthy connection's write did not reach the platform")
        .toHaveLength(1);
      expect(bridge.native.accepted[0]!.toString(), "the bytes were altered on the way through")
        .toBe(CHUNK.toString());
      expect(handed, "the write was reported as a failure").toBeNull();
      expect(
        lines.filter((l) => l.event === "socket_write_after_close"),
        "a healthy write was logged as a refusal",
      ).toHaveLength(0);
      expect(seen.errors).toHaveLength(0);
    }, CASE_MS);

    it("EMITS ITS `close` EXACTLY ONCE, and the bytes already read still arrive", async () => {
      const bridge = shim.connect({ host: "imap.invalid", port: 993 });
      const seen = watch(bridge);
      bridge.native.emit("connect");

      /* The last response and the hang-up in one turn. Ending the writable side must not discard
         what the readable side already holds — a dropped final response is a command the client
         waits on for ever. */
      bridge.native.emit("data", Buffer.from("* OK final response\r\n"));
      bridge.native.destroy();
      bridge.native.emit("close", false);

      const read: Buffer[] = [];
      bridge.on("data", (chunk) => { read.push(chunk as Buffer); });
      await arrived("the bytes read before the hang-up, and its close",
        () => Buffer.concat(read).toString() === "* OK final response\r\n" && seen.closes >= 1,
        () => `${Buffer.concat(read).length} byte(s), ${seen.closes} close(s)`);
      await settle();

      expect(
        Buffer.concat(read).toString(),
        "the response the server had already sent was discarded by the teardown",
      ).toBe("* OK final response\r\n");
      expect(
        seen.closes,
        "one connection produced more than one `close` — the stream layer emitted a second",
      ).toBe(1);
    }, CASE_MS);
  },
);

/**
 * THE READING THE COUNTERS ABOVE STAND IN FOR, taken where nothing is listening at all.
 *
 * Every case above attaches an `error` counter, and attaching one is what stops an emit being a
 * throw — so on its own the suite measures "was `error` emitted" and asserts that it answers the
 * product question. This arm asks the product question directly: a fresh process, no listener, no
 * `uncaughtException` handler, the shim over Node's own sockets, a write after the server hung up.
 * A non-zero exit is the app crash the artifact produced.
 */
describe("the refusal in a process with nothing listening", () => {
  const child = (body: string): { status: number | null; out: string } => {
    const script = `
      const Module = require("node:module");
      const net = require("node:net"), tls = require("node:tls");
      const original = Module._load;
      Module._load = function (request, parent, isMain) {
        if (request === "react-native-tcp-socket") {
          return { createConnection: net.createConnection, connectTLS: tls.connect,
                   TLSSocket: tls.TLSSocket, isIP: net.isIP, isIPv4: net.isIPv4, isIPv6: net.isIPv6 };
        }
        return original.call(this, request, parent, isMain);
      };
      const shim = require(${JSON.stringify(require_.resolve(SHIM))});
      Module._load = original;
      ${body}
    `;
    try {
      const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
      return { status: 0, out };
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  it("does not take the process down when the server hangs up first", () => {
    const run = child(`
      const server = net.createServer((s) => { s.destroy(); });
      server.listen(0, "127.0.0.1", () => {
        const bridge = shim.connect({ host: "127.0.0.1", port: server.address().port });
        bridge.native.on("close", () => {
          setTimeout(() => {
            bridge.write(Buffer.from("${"A"}1 NOOP\\r\\n"));
            setTimeout(() => { console.log("SURVIVED"); server.close(); process.exit(0); }, 100);
          }, 20);
        });
      });
    `);
    expect(run.out, `the write after the hang-up took the process down:\n${run.out}`)
      .toContain("SURVIVED");
    expect(run.status, "the process exited non-zero — the refusal reached the top").toBe(0);
  }, 30_000);

  it("does not take the process down when the socket was destroyed with no close event", () => {
    const run = child(`
      const server = net.createServer(() => {});
      server.listen(0, "127.0.0.1", () => {
        const bridge = shim.connect({ host: "127.0.0.1", port: server.address().port });
        bridge.on("connect", () => {
          bridge.native.destroy();
          bridge.write(Buffer.from("${"A"}1 NOOP\\r\\n"));
          setTimeout(() => { console.log("SURVIVED"); server.close(); process.exit(0); }, 100);
        });
      });
    `);
    expect(run.out, `the write after the destroy took the process down:\n${run.out}`)
      .toContain("SURVIVED");
    expect(run.status, "the process exited non-zero — the refusal reached the top").toBe(0);
  }, 30_000);
});

/**
 * A LARGE WRITE ON A SLOW LINK KEEPS ITS CONNECTION. The platform's socket timer is reset only
 * when a whole native write completes or data arrives, and nodemailer hands a photo letter's DATA
 * to the socket as one ~958 KB write: the timer fired part-way through an upload whose bytes were
 * still moving. The bridge hands the platform at most 16 KiB per write, so the timer tracks
 * progress. Time runs scaled: 1 MB/s for the slow link, 250 ms for the 25 s deadline.
 */
describe("the bridge on a slow link", () => {
  it("a 958 KB write arrives as pieces of at most 16 KiB, and the socket timer never fires while bytes move", async () => {
    const net = await import("node:net");
    let received = 0;
    const server = net.createServer((sock) => { sock.on("data", (d) => { received += d.length; }); sock.on("error", () => undefined); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const double = platformDouble("", { writeRate: 1_000_000 });
    const Module = require_("node:module") as { _load(req: string, parent: unknown, isMain: boolean): unknown };
    const original = Module._load;
    Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
      return request === "react-native-tcp-socket" ? double.module : original.call(this, request, parent, isMain);
    };
    let shim: Shim;
    try {
      const cache = (require_ as unknown as { cache: Record<string, unknown> }).cache;
      for (const key of Object.keys(cache)) if (key.includes("engine/shims/net.js")) delete cache[key];
      shim = require_(SHIM) as Shim;
    } finally { Module._load = original; }
    const bridge = shim.connect({ host: "127.0.0.1", port: (server.address() as { port: number }).port }) as Bridge & {
      setTimeout(ms: number): unknown; destroy(): void;
    };
    try {
      await new Promise<void>((r) => { bridge.once("connect", () => r()); });
      let timeouts = 0;
      bridge.on("timeout", () => { timeouts += 1; });
      bridge.setTimeout(250);
      const photo = Buffer.alloc(958_386, 0x41);
      let done: unknown = NEVER;
      bridge.write(photo, (err) => { done = err ?? null; });
      await arrived("the write's callback", () => done !== NEVER);
      expect(done, "the write failed").toBeNull();
      const writes = double.conns[0]!.writes;
      expect(Math.max(...writes), "one native write carried more than 16 KiB").toBeLessThanOrEqual(16 * 1024);
      expect(writes.reduce((a, b) => a + b, 0)).toBe(photo.length);
      expect(timeouts, "the socket timer fired while the upload was still moving").toBe(0);
      await arrived("every byte at the server", () => received === photo.length, () => `${received} bytes`);
    } finally {
      bridge.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, CASE_MS);
});
