import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * A MAILBOX GIVEN BY IP ADDRESS DIALS, INSTEAD OF DYING ON A TypeError.
 *
 * `imapflow` sets `servername: false` for an IP-literal host — RFC 6066 forbids an IP in SNI — and
 * node reads that falsy value as "no SNI". The phone's platform socket refuses it by class ("Value
 * for servername cannot be cast from Boolean to String"), so the dial threw before the handshake
 * and the app reported a closed connection. Measured on a device against a server reached by IP.
 * The shim drops a servername that is not a name; the control is that a real one still travels.
 */

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const TLS_SHIM = join(here, "../src/engine/shims/tls.js");

type Options = Record<string, unknown>;
type Bridge = { emit: (e: string, ...a: unknown[]) => void; on: (e: string, f: () => void) => void };
type Shim = {
  connect: (o: Options, l?: () => void) => unknown;
  withNameOrNoSni: (o: Options) => Options;
  confirmUpgrade: (n: unknown, b: Bridge, settled: () => boolean, waitMs?: number) => void;
};

/** Load the shim with the native package answered by a recorder. */
function loadShim(): { tls: Shim; seen: Options[] } {
  const seen: Options[] = [];
  const Module = req("node:module") as { _load(r: string, p: unknown, m: boolean): unknown };
  const original = Module._load;
  /* The double answers what the platform answers, including the peer certificate the upgrade's
     confirmation asks for — a double missing it would fail in a way production cannot. */
  const fake = () => ({
    on: () => undefined, once: () => undefined, write: () => true, destroy: () => undefined,
    getPeerCertificate: () => Promise.resolve({ subject: { CN: "mail.example.com" } }),
  });
  Module._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "react-native-tcp-socket") {
      return {
        createConnection: () => fake(),
        connectTLS: (o: Options) => { seen.push(o); return fake(); },
        TLSSocket: class { constructor(_socket: unknown, o: Options) { seen.push(o); return fake() as never; } },
        isIP: () => 0, isIPv4: () => false, isIPv6: () => false,
      };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    const cache = (req as unknown as { cache: Record<string, unknown> }).cache;
    for (const key of Object.keys(cache)) {
      if (key.includes("engine/shims/net.js") || key.includes("engine/shims/tls.js")) delete cache[key];
    }
    return { tls: req(TLS_SHIM) as Shim, seen };
  } finally { Module._load = original; }
}

describe("the phone's TLS shim and SNI", () => {
  it("drops a servername that is not a name, on both routes", () => {
    const { tls, seen } = loadShim();

    tls.connect({ host: "10.0.2.2", port: 4843, servername: false, rejectUnauthorized: true });
    tls.connect({ socket: { native: {} }, servername: false, rejectUnauthorized: true });

    expect(seen).toHaveLength(2);
    for (const options of seen) {
      expect(options).not.toHaveProperty("servername");
      // The rest of the floor is untouched: dropping SNI may not drop the verification with it.
      expect(options.rejectUnauthorized).toBe(true);
    }
  });

  it("carries a real servername through, so the drop is not a blanket one", () => {
    const { tls, seen } = loadShim();

    tls.connect({ host: "mail.example.com", port: 993, servername: "mail.example.com" });
    tls.connect({ socket: { native: {} }, servername: "mail.example.com" });

    expect(seen).toHaveLength(2);
    for (const options of seen) expect(options.servername).toBe("mail.example.com");
  });

  it("leaves options that never named SNI exactly as they came", () => {
    const { tls } = loadShim();
    const given = { host: "mail.example.com", port: 993, rejectUnauthorized: true };
    expect(tls.withNameOrNoSni(given)).toBe(given);
    // An empty name is not a name either: it would be sent as an empty SNI extension.
    expect(tls.withNameOrNoSni({ servername: "" })).not.toHaveProperty("servername");
  });
});

/**
 * A STARTTLS UPGRADE TELLS THE CALLER IT FINISHED.
 *
 * The platform emits `secureConnect` for a fresh TLS dial only: an upgrade emits nothing, so
 * imapflow's upgrade callback never ran, the dial died on its own timeout and the app reported a
 * closed connection. Measured on a device against a STARTTLS server. Android's end is asked of it
 * (a peer certificate exists only after its handshake); iOS says its end as the upgraded socket's
 * own `connect` and shows no certificate at all, so a poll with a bound refused every iOS upgrade.
 */
describe("the phone's TLS shim and the STARTTLS upgrade", () => {
  const bridge = () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    return {
      events, errors,
      emit(name: string, payload?: unknown) { events.push(name); if (name === "error") errors.push(payload); },
      on() { /* the guard reads `events`, not a listener */ },
    };
  };

  it("emits secureConnect once the platform has a peer certificate", async () => {
    const { tls } = loadShim();
    const b = bridge();
    const native = { getPeerCertificate: () => Promise.resolve({ subject: { CN: "mail.example.com" } }) };
    tls.confirmUpgrade(native, b, () => false, 1);
    await vi.waitFor(() => expect(b.events).toContain("secureConnect"));
    expect(b.errors).toHaveLength(0);
  });

  it("takes the upgraded socket's own connect as the end, with no certificate to show", async () => {
    const { tls } = loadShim();
    const b = bridge();
    const native = Object.assign(new EventEmitter(), { getPeerCertificate: () => Promise.resolve(null) });
    tls.confirmUpgrade(native, b, () => false, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(b.events, "secured before the platform said so").not.toContain("secureConnect");
    native.emit("connect");
    native.emit("connect");
    expect(b.events.filter((e) => e === "secureConnect")).toHaveLength(1);
    expect(b.errors).toHaveLength(0);
  });

  it("WIRES that confirmation into connect(), so the caller's upgrade callback runs", async () => {
    const { tls } = loadShim();
    let called = 0;
    // The upgrade route — `tls.connect({ socket })` — is the one the platform leaves silent. A
    // callback that never runs is exactly what imapflow waited for until its own timeout.
    tls.connect({ socket: { native: {} }, servername: false }, () => { called += 1; });
    await vi.waitFor(() => expect(called).toBe(1));
  });

  it("asks again after an empty or null answer, never reads one as secured, and stops once supervision settles", async () => {
    const { tls } = loadShim();
    const b = bridge();
    let asked = 0;
    let settled = false;
    const native = { getPeerCertificate: () => { asked += 1; return Promise.resolve(asked % 2 === 0 ? null : {}); } };
    tls.confirmUpgrade(native, b, () => settled, 1);
    await vi.waitFor(() => expect(asked).toBeGreaterThanOrEqual(6));
    expect(b.events).not.toContain("secureConnect");
    expect(b.errors, "an answer with no certificate is not a verdict; the deadline is").toHaveLength(0);
    settled = true;
    await new Promise((r) => setTimeout(r, 20));
    const after = asked;
    await new Promise((r) => setTimeout(r, 30));
    expect(asked, "still asking after supervision settled").toBe(after);
  });

  it("carries a platform refusal out as an error rather than as silence", async () => {
    const { tls } = loadShim();
    const b = bridge();
    const native = { getPeerCertificate: () => Promise.reject(new Error("socket is closed")) };
    tls.confirmUpgrade(native, b, () => false, 1);
    await vi.waitFor(() => expect(b.errors).toHaveLength(1));
    expect(b.events).not.toContain("secureConnect");
  });
});
