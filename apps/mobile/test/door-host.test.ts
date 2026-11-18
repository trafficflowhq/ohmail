/**
 * THE DOOR'S HOST, over a connection double and the real seams around it: the page's requests go through the bridge's
 * native end and the door's own guard, the tickets give leases back through the pairing's own `discardAdmission`
 * over a pin registry double, and a mailbox is opened through the engine's own `openStandaloneMailbox` and the
 * organizer session's own launch slot. What must hold: the redeem is reachable only by a ticket; no answer, event or
 * state carries a code, a refresh token or a password; the standalone order, and its slot given back on a throw.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armConsentPress, forgetOrganizerSessionForTests, organizerDoor, organizerRestrictedSaid, standaloneLaunchGeneration,
  takeConsentPress,
} from "../src/engine/organizer-session";
import type { StandaloneEngine, StartPhoneEngine, StoreMigrating } from "../src/engine/standalone-door";
import type { Attempt, ConnectionState, ForgetAttempt } from "../src/net/connection";
import { installPinning, type PinningNative } from "../src/net/host-pinning";
import type { Negotiation, PairAdmission, ProbeOutcome, ShellSession } from "../src/net/pairing";
import { refuse } from "../src/refusal";
import type { ServerProfile } from "../src/state/servers";
import type { DoorAt, DoorConfig, DoorEvent, DoorKind, DoorRequests, DoorState, Rect } from "../src/shell/door-kinds";
import { DoorHost, SCAN_REARM_MS, type DoorConnection } from "../src/shell/door-host";
import { said } from "../src/shell/door-state";
import { TICKET_LIFE_MS } from "../src/shell/door-tickets";
import { bootMigratingLines, type BootMigrating } from "../src/ui/boot-migrating";

/**
 * The field's check and the parse share one rule today, so no typed address reaches the pairing's own "not a server
 * address" arm; a case stands a drift between them in: the check lets `letThrough` pass, everything else is real.
 */
const drift = vi.hoisted(() => ({ letThrough: null as string | null }));
vi.mock("../src/net/server-base", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/net/server-base")>();
  return { ...real, addressProblem: (typed: string) => (typed === drift.letThrough ? null : real.addressProblem(typed)) };
});

const ORIGIN = "https://appassets.androidplatform.net";
const LOCAL = "http://sidecar";
/** Planted: none of these may be in anything the host posts. */
const CODE_SCANNED = "scanned-code-7Jq2mZx9";
const CODE_TYPED = "typed-code-4Lr8nWb3";
const CODE_PASTED = "pasted-code-9Tk5vQd1";
const REFRESH = "refresh-token-2Hs6pYc8";
const PASSWORD = "mailbox-password-3Fg7jNe5";
const KEY = "K".repeat(43);

const profile = (over: Partial<ServerProfile>): ServerProfile => ({
  id: "row-1", origin: "https://mail.example.test", flavor: "selfhost", accountId: "account-1", refreshToken: REFRESH,
  refreshAttempt: null, apiBase: null, pin: null, ...over,
});
const OWN = profile({ id: "row-own", origin: LOCAL, flavor: "local", accountId: "engine-account", refreshToken: null });
const shell = (p: ServerProfile): ConnectionState => ({ k: "shell", session: { profile: p } as unknown as ShellSession });

function pins() {
  const held = new Map<string, string>();
  const native: PinningNative = {
    isInstalled: () => true, factoryUses: () => 1,
    setPin: (host, port, spki) => held.set(`${host}:${port}`, spki).size,
    clearPin: (host, port) => (held.delete(`${host}:${port}`), held.size),
    clearAllPins: () => (held.clear(), 0), pinnedCount: () => held.size,
  };
  installPinning(native);
  return held;
}

/** The engine double: what a start was handed, and the door it answers with. */
function engine() {
  const started: Parameters<StartPhoneEngine>[0][] = [];
  const door = { accountId: "engine-account", address: "ada@example.test" } as unknown as StandaloneEngine;
  const start: StartPhoneEngine = async (deps) => {
    started.push(deps);
    return door;
  };
  return { started, door, start };
}

function world(opts: { asked?: DoorAt | null; offered?: boolean } = {}) {
  const sent: string[] = [];
  const answers = new Map<number, (m: Record<string, unknown>) => void>();
  const events: DoorEvent[] = [];
  const log: string[] = [];
  const clock = { now: 0, timers: [] as { at: number; fn: () => void; live: boolean }[] };
  const held = pins();
  const eng = engine();
  let minted = 0;
  /** What a case turns: the camera's permission, where it stands, and the two faults of an open. */
  const dials = { camera: true, shown: null as Rect | null, depsThrow: false, sessionFails: false };

  const conn: {
    -readonly [K in keyof DoorConnection]: DoorConnection[K];
  } & {
    probes: [string, string | null][]; redeemed: [PairAdmission, string][]; probe: (origin: string) => ProbeOutcome;
    redeem: Attempt; adopt: () => Promise<Attempt>; forgot: ForgetAttempt; hello: Negotiation; switched: Attempt;
  } = {
    state: { k: "idle" }, syncing: false, syncError: null, profiles: [], activeId: null,
    probes: [], redeemed: [], redeem: { ok: true }, adopt: async () => ({ ok: true }), forgot: { ok: true },
    switched: { ok: true },
    hello: { kind: "hello", hello: { flavor: "selfhost", pairing: true, needsSetup: false, apiVersion: "1" } },
    /* A probe as the pairing's: the key the link named is installed before anything dials, as a lease. */
    probe: (origin) => ({ kind: "offers", admission: { origin, pin: KEY, flavor: "desktop-host", apiBase: origin, provisionalPin: true, probed: true } }),
    ask: async () => conn.hello,
    probeBase: async (origin) => ({ kind: "base", base: `${origin}/api`, prefixed: true }),
    probePair: async (origin, pin) => {
      conn.probes.push([origin, pin ?? null]);
      const outcome = conn.probe(origin);
      if (outcome.kind === "offers" && outcome.admission.provisionalPin) {
        const at = /^https:\/\/([^:]+):(\d+)$/.exec(origin);
        if (at) held.set(`${at[1]}:${at[2]}`, KEY);
      }
      return outcome;
    },
    pairConfirmed: async (admission, token) => {
      conn.redeemed.push([admission, token]);
      return conn.redeem;
    },
    openStandalone: async (door) => {
      log.push(`adopt:${organizerDoor() === door ? "held" : "not held"}`);
      return conn.adopt();
    },
    switchTo: async (id) => (log.push(`switch:${id}`), conn.switched),
    forget: async (id, o) => (log.push(`forget:${id}:${o?.anyway === true}`), conn.forgot),
    unsentDraftsHere: () => null,
    disconnect: async () => { log.push("disconnect"); },
    syncNow: async () => { log.push("sync"); },
  };

  const host = new DoorHost({
    post: (_epoch, text) => {
      sent.push(text);
      const m = JSON.parse(text) as Record<string, unknown>;
      if (typeof m.type === "string") events.push(m as unknown as DoorEvent);
      else answers.get(m.id as number)?.(m);
    },
    conn: () => conn,
    facts: () => ({
      app: "ohmail", os: "android", pad: false, language: "en", build: { version: "2.0.0", commit: null },
      facts: { posture: { folds: [], hasFold: false }, insets: { top: 0, right: 0, bottom: 0, left: 0 }, keyboard: { height: 0 }, online: true },
    }),
    asked: opts.asked ?? null,
    tickets: {
      mint: () => (minted += 1).toString(16).padStart(32, "0"),
      now: () => clock.now,
      later: (fn, ms) => {
        const timer = { at: clock.now + ms, fn, live: true };
        clock.timers.push(timer);
        return () => { timer.live = false; };
      },
    },
    standalone: {
      offered: () => opts.offered ?? true,
      deps: () => {
        if (dials.depsThrow) throw new Error("the platform threw");
        return {
        startEngine: async (deps) => {
          const armed = takeConsentPress();
          if (armed) armConsentPress();
          log.push(`engine:${armed ? "armed" : "not armed"}`);
          return eng.start(deps);
        },
        platform: async () => ({ kind: "ready", exec: {}, keks: {} }),
        machineName: () => "ohmail on a phone",
        installId: async () => "install-1",
        };
      },
      startSession: async (door, address, launch) => {
        if (dials.sessionFails) throw new Error("no background half in this build");
        log.push(`session:${organizerDoor() === door ? "held" : "not held"}:${address}:${launch === standaloneLaunchGeneration()}`);
      },
      noticeGate: async () => { log.push("notice"); },
    },
    camera: { permitted: () => dials.camera, allow: async () => (dials.camera = true), show: (rect) => { dials.shown = rect; } },
    entered: () => { log.push("entered"); },
    back: () => { log.push("back"); },
    ready: () => { log.push("ready"); },
    wake: () => { log.push("wake"); },
    openSettings: async (what) => { log.push(`settings:${what}`); },
  });

  let next = 1;
  let epoch = "";
  const begin = (e: string) => {
    epoch = e;
    host.begin(e);
  };
  /** One request of the page's, through the admit check, the epoch check and the guard. */
  const post = (kind: string, fields: object = {}, at = epoch) => {
    const id = next++;
    return new Promise<Record<string, unknown>>((resolve) => {
      answers.set(id, resolve);
      host.receive({ epoch: at, origin: ORIGIN, mainFrame: true, data: JSON.stringify({ id, epoch: at, kind, ask: fields }) });
    });
  };
  const ask = async <K extends DoorKind>(kind: K, fields: DoorRequests[K]["ask"]): Promise<DoorRequests[K]["answer"]> => {
    const m = await post(kind, fields);
    if (m.ok !== true) throw new Error(`the bridge refused ${kind}: ${String(m.refused)}`);
    return m.answer as DoorRequests[K]["answer"];
  };
  const pass = (ms: number) => {
    clock.now += ms;
    for (const t of clock.timers) if (t.live && t.at <= clock.now) { t.live = false; t.fn(); }
  };
  begin("e1");
  return { host, conn, sent, events, log, eng, held, begin, post, ask, pass, dials };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const lastState = (events: DoorEvent[]): DoorState | undefined =>
  (events.filter((e) => e.type === "state").at(-1) as Extract<DoorEvent, { type: "state" }> | undefined)?.state;
const INPUT = {
  address: " ada@example.test ", pass: PASSWORD, name: "Ada", imap: { host: "imap.example.test", port: 993 }, smtp: { host: "smtp.example.test", port: 465 },
};

afterEach(() => {
  drift.letThrough = null;
  installPinning(null);
  forgetOrganizerSessionForTests();
});

describe("the door's host: pairing", () => {
  it("the redeem is reachable only by a ticket: taken once, the second pair is refused and redeems nothing", async () => {
    const w = world();
    const offer = await w.ask("hand", { address: "https://192.168.1.20:8443", token: CODE_TYPED });
    if (offer.k !== "offers") throw new Error("no offer");
    expect(offer.facts).toEqual({ what: "computer", address: "https://192.168.1.20:8443", key: "KKKKKK…KKKKKK" });
    expect(w.conn.redeemed).toEqual([]);
    expect(await w.ask("pair", { ticket: offer.ticket })).toEqual({ ok: true });
    expect(w.conn.redeemed).toHaveLength(1);
    expect(w.conn.redeemed[0]![1]).toBe(CODE_TYPED);
    expect(w.conn.redeemed[0]![0]).toMatchObject({ origin: "https://192.168.1.20:8443", probed: true });
    expect(w.log).toContain("entered");
    expect(await w.ask("pair", { ticket: offer.ticket })).toEqual({ ok: false, said: { code: "pairCodeRejected", args: [] } });
    expect(w.conn.redeemed).toHaveLength(1);
  });

  it("a pair with no ticket, an expired one or one of a page that ended redeems nothing", async () => {
    const w = world();
    expect(await w.ask("pair", { ticket: "f".repeat(32) })).toMatchObject({ ok: false });
    const late = await w.ask("hand", { address: "https://192.168.1.20:8443", token: CODE_TYPED });
    w.pass(TICKET_LIFE_MS + 1);
    expect(await w.ask("pair", { ticket: (late as { ticket: string }).ticket })).toMatchObject({ ok: false });
    const old = await w.ask("hand", { address: "https://192.168.1.20:8443", token: CODE_TYPED });
    w.begin("e2");
    expect(await w.ask("pair", { ticket: (old as { ticket: string }).ticket })).toMatchObject({ ok: false });
    // A request that names no ticket at all does not pass the guard.
    expect(await w.post("pair", {})).toMatchObject({ ok: false, refused: "malformed" });
    expect(await w.post("pair", { admission: { origin: "https://192.168.1.20:8443" }, token: CODE_TYPED })).toMatchObject({ ok: false, refused: "malformed" });
    expect(w.conn.redeemed).toEqual([]);
    expect(w.log).not.toContain("entered");
  });

  it("a dismiss, a page end, a closed door and a new offer each give back the key the probe installed", async () => {
    const w = world();
    const offered = async (address = "https://192.168.1.20:8443") => {
      const offer = await w.ask("hand", { address, token: CODE_TYPED });
      expect(w.held.size).toBeGreaterThan(0);
      return (offer as { ticket: string }).ticket;
    };
    await w.ask("dismiss", { ticket: await offered() });
    expect(w.held.size, "a dismiss").toBe(0);
    await offered();
    w.begin("e2");
    expect(w.held.size, "a page end").toBe(0);
    await offered();
    await offered("https://192.168.1.21:8443");
    expect([...w.held.keys()], "a new offer ends the one before it").toEqual(["192.168.1.21:8443"]);
    w.host.close();
    expect(w.held.size, "the door closing").toBe(0);
    // A stored pairing's own key is not the probe's to drop.
    w.conn.probe = (origin) => ({ kind: "offers", admission: { origin, pin: KEY, flavor: "desktop-host", apiBase: origin, provisionalPin: false, probed: true } });
    w.begin("e3");
    w.held.set("192.168.1.20:8443", KEY);
    await w.ask("dismiss", { ticket: await offered() });
    expect(w.held.size).toBe(1);
  });

  /** What ends the page that handed the code in, and what opens page e2 the next press comes from. */
  const LATE: [string, (w: ReturnType<typeof world>) => void, (w: ReturnType<typeof world>) => void][] = [
    ["its page ended", (w) => w.begin("e2"), () => {}],
    ["the door closed", (w) => w.host.close(), (w) => w.begin("e2")],
  ];
  for (const [after, end, next] of LATE) {
    it(`a code handed in whose probe answers after ${after} offers nothing and gives the key back`, async () => {
      const w = world();
      // The address is still being asked when the page ends: the key is installed, the answer is not in yet.
      let answer = () => {};
      w.conn.probePair = (origin) => new Promise<ProbeOutcome>((resolve) => {
        w.held.set("192.168.1.20:8443", KEY);
        answer = () => resolve(w.conn.probe(origin));
      });
      void w.post("hand", { address: null, token: `https://192.168.1.20:8443/pair#k1.${KEY}.${CODE_PASTED}` });
      await settle();
      expect(w.held.size, "the probe holds its key").toBe(1);
      end(w);
      answer();
      await settle();
      expect(w.held.size).toBe(0);
      next(w);
      // The ticket the probe would have been offered under is the next one minted: no page holds it.
      expect(await w.ask("pair", { ticket: "1".padStart(32, "0") })).toMatchObject({ ok: false });
      expect(w.conn.redeemed).toEqual([]);
    });
  }

  it("a code handed in that the page stopped waiting for offers nothing and gives the key back at once", async () => {
    const w = world();
    let answer = () => {};
    w.conn.probePair = (origin) => new Promise<ProbeOutcome>((resolve) => {
      w.held.set("192.168.1.20:8443", KEY);
      answer = () => resolve(w.conn.probe(origin));
    });
    // The page's first request (id 1); its deadline passes, and the page sends `cancel` for it.
    const handed = w.post("hand", { address: null, token: `https://192.168.1.20:8443/pair#k1.${KEY}.${CODE_PASTED}` });
    await settle();
    expect(w.held.size, "the probe holds its key").toBe(1);
    await w.ask("cancel", { of: 1 });
    answer();
    expect(await handed).toMatchObject({ ok: false, refused: "cancelled" });
    expect(w.held.size).toBe(0);
    expect(await w.ask("pair", { ticket: "1".padStart(32, "0") })).toMatchObject({ ok: false });
    expect(w.conn.redeemed).toEqual([]);
  });

  it("a pasted link wins over the address and carries its key; a typed code carries none; an empty one probes nothing", async () => {
    const w = world();
    await w.ask("hand", { address: "https://mail.example.test", token: `https://192.168.1.20:8443/pair#k1.${KEY}.${CODE_PASTED}` });
    await w.ask("hand", { address: "https://mail.example.test", token: CODE_TYPED });
    expect(w.conn.probes).toEqual([["https://192.168.1.20:8443", KEY], ["https://mail.example.test", null]]);
    expect(await w.ask("hand", { address: "https://mail.example.test", token: "  " })).toEqual({ k: "refused", said: { code: "pairEmptyToken", args: [] } });
    expect(w.conn.probes).toHaveLength(2);
  });

  it("reads a typed address as the server step does: the confirmation shows the host the code goes to", async () => {
    const w = world();
    // Each would be shown whole on the confirmation and dialled at the host after the "@", or under a path.
    for (const address of ["https://mail.example.test@other.example.test", "mail.example.test:8443@other.example.test", "https://mail.example.test/pair"]) {
      expect(await w.ask("hand", { address, token: CODE_TYPED }), address).toEqual({ k: "refused", said: { code: "baseNotAnAddress", args: [] } });
    }
    expect(w.conn.probes).toEqual([]);
    const offer = await w.ask("hand", { address: " Mail.Example.Test/ ", token: CODE_TYPED });
    expect(w.conn.probes).toEqual([["https://mail.example.test", null]]);
    expect(offer).toMatchObject({ k: "offers", facts: { address: "https://mail.example.test" } });
  });

  it("an address the field's check lets through and the parse refuses: the sentence names what was typed", async () => {
    const w = world();
    const typed = "https://mail.example.test/pair";
    drift.letThrough = typed;
    expect(await w.ask("hand", { address: typed, token: CODE_TYPED }))
      .toEqual({ k: "refused", said: { code: "pairBadAddress", args: [typed] } });
    expect(w.conn.probes).toEqual([]);
  });

  it("a link the grammar refuses is no code: a newer code's link or one with a query goes to no server", async () => {
    const w = world();
    await w.ask("server.ask", { address: "mail.example.test" });
    for (const token of [`https://other.example.test/pair#k2.${KEY}.${CODE_PASTED}`, `https://other.example.test/pair?from=desk#${CODE_PASTED}`]) {
      for (const address of ["https://mail.example.test", null]) {
        expect(await w.ask("hand", { address, token }), `${token} at ${address}`).toEqual({ k: "refused", said: { code: "pairCodeRejected", args: [] } });
      }
    }
    expect(w.conn.probes).toEqual([]);
    expect(w.conn.redeemed).toEqual([]);
  });

  it("calls a server hosted only at the hosted address, on the confirmation and in the list", async () => {
    const w = world();
    w.conn.probe = (origin) => ({ kind: "offers", admission: { origin, pin: null, flavor: "managed", apiBase: origin, provisionalPin: false, probed: true } });
    expect(await w.ask("hand", { address: "https://mail.example.test", token: CODE_TYPED }))
      .toMatchObject({ k: "offers", facts: { what: "server", address: "https://mail.example.test" } });
    expect(await w.ask("hand", { address: "https://api.ohmail.app", token: CODE_TYPED }))
      .toMatchObject({ k: "offers", facts: { what: "hosted", address: "https://api.ohmail.app" } });
    w.conn.profiles = [profile({ flavor: "managed" }), profile({ id: "row-2", origin: "https://api.ohmail.app", flavor: "managed" })];
    expect((await w.ask("config", {})).state.paired.map((row) => [row.address, row.kind]))
      .toEqual([["https://mail.example.test", "server"], ["https://api.ohmail.app", "hosted"]]);
  });

  it("a link whose host reads as one name and is dialled as another is no code, pasted or scanned", async () => {
    const w = world();
    // A Cyrillic "е": drawn as desk, dialled as its xn-- name.
    const lookalike = `https://dеsk.example.test/pair#${CODE_PASTED}`;
    expect(await w.ask("hand", { address: null, token: lookalike })).toEqual({ k: "refused", said: { code: "pairCodeRejected", args: [] } });
    await w.ask("scan.start", { rect: { x: 0, y: 0, w: 10, h: 10 } });
    w.host.scanned(lookalike);
    await settle();
    expect(w.events.at(-1)).toMatchObject({ type: "scan", scan: { k: "notACode" } });
    expect(w.conn.probes).toEqual([]);
  });

  it("asks an address what it is, holds a reached one for the code typed next, and says why an unreached one is not", async () => {
    const w = world();
    expect(await w.ask("server.ask", { address: "mail.example.test" }))
      .toEqual({ k: "reached", address: "https://mail.example.test", flavor: "selfhost", apiUnder: "https://mail.example.test/api" });
    await w.ask("hand", { address: null, token: CODE_TYPED });
    expect(w.conn.probes.at(-1)).toEqual(["https://mail.example.test", null]);
    // The hosted address is not measured for its base.
    expect(await w.ask("server.ask", { address: "https://api.ohmail.app" })).toMatchObject({ k: "reached", apiUnder: null });
    expect(await w.ask("server.ask", { address: "" })).toMatchObject({ k: "refused", said: { code: "baseAddressMissing" } });
    w.conn.hello = { kind: "not-ohmail" };
    expect(await w.ask("server.ask", { address: "mail.example.test" })).toEqual({ k: "refused", said: { code: "notOhmail", args: [] } });
    w.conn.hello = { kind: "unreachable", detail: "javax.net.ssl.SSLException: Unable to parse TLS packet header" };
    expect(await w.ask("server.ask", { address: "mail.example.test" })).toEqual({ k: "refused", said: { code: "notEncrypted", args: [] } });
    w.conn.hello = { kind: "unreachable", detail: "java.net.UnknownHostException: Unable to resolve host" };
    expect(await w.ask("server.ask", { address: "mail.example.test" }))
      .toEqual({ k: "refused", said: { code: "unreachableWhy", args: [{ code: "unreachableDns", args: [] }] } });
    w.conn.hello = { kind: "hello", hello: { flavor: "managed", pairing: false, needsSetup: false, apiVersion: "1" } };
    expect(await w.ask("server.ask", { address: "mail.example.test" })).toMatchObject({ k: "refused", said: { code: "managedDeferred" } });
  });

  it("scans natively: a frame that is no code says so and waits; a code is probed and only what was measured crosses", async () => {
    const w = world();
    expect(await w.ask("scan.move", { rect: { x: 0, y: 0, w: 10, h: 10 } }), "a move starts nothing").toEqual({ camera: "off" });
    expect(await w.ask("scan.start", { rect: { x: 0, y: 100, w: 360, h: 360 } })).toEqual({ camera: "on" });
    expect(w.dials.shown).toEqual({ x: 0, y: 100, w: 360, h: 360 });
    w.host.scanned("https://example.test/not-a-pairing");
    w.host.scanned(`https://192.168.1.20:8443/pair#k1.${KEY}.${CODE_SCANNED}`);
    expect(w.conn.probes, "disarmed after a frame that was no code").toEqual([]);
    expect(w.events.at(-1)).toMatchObject({ type: "scan", scan: { k: "notACode" } });
    w.pass(SCAN_REARM_MS);
    w.host.scanned(`https://192.168.1.20:8443/pair#k1.${KEY}.${CODE_SCANNED}`);
    w.host.scanned(`https://192.168.1.20:8443/pair#k1.${KEY}.${CODE_SCANNED}`);
    await settle();
    expect(w.conn.probes).toEqual([["https://192.168.1.20:8443", KEY]]);
    const scan = w.events.at(-1) as Extract<DoorEvent, { type: "scan" }>;
    expect(scan.scan).toMatchObject({ k: "offers", facts: { what: "computer", address: "https://192.168.1.20:8443" } });
    expect(w.dials.shown, "the camera is put away for the confirmation").toBeNull();
    expect(await w.ask("pair", { ticket: (scan.scan as { ticket: string }).ticket })).toEqual({ ok: true });
    expect(w.conn.redeemed[0]![1]).toBe(CODE_SCANNED);
  });

  it("offers nothing for a scan that was stopped while its address was asked, and gives the key back", async () => {
    const w = world();
    await w.ask("scan.start", { rect: { x: 0, y: 0, w: 10, h: 10 } });
    // The address is still being asked when the page leaves the scan: the key is installed, the answer is not in yet.
    let answer = () => {};
    w.conn.probePair = (origin) => new Promise<ProbeOutcome>((resolve) => {
      w.held.set("192.168.1.20:8443", KEY);
      answer = () => resolve(w.conn.probe(origin));
    });
    w.host.scanned(`https://192.168.1.20:8443/pair#k1.${KEY}.${CODE_SCANNED}`);
    await w.ask("scan.stop", {});
    expect(w.held.size).toBe(1);
    answer();
    await settle();
    expect(w.events.filter((e) => e.type === "scan")).toEqual([]);
    expect(w.held.size).toBe(0);
    expect(await w.ask("pair", { ticket: "00000000000000000000000000000001" })).toMatchObject({ ok: false });
    w.dials.camera = false;
    expect(await w.ask("scan.start", { rect: { x: 0, y: 0, w: 10, h: 10 } })).toEqual({ camera: "off" });
    expect(await w.ask("camera.allow", {})).toEqual({ camera: "on" });
  });
});

describe("the door's host: nothing secret crosses outward", () => {
  it("no answer, event or state holds a planted code, refresh token or password", async () => {
    const w = world();
    w.conn.profiles = [profile({}), profile({ id: "row-2", refreshAttempt: REFRESH }), OWN];
    w.conn.activeId = "row-1";
    w.conn.state = shell(profile({}));
    await w.ask("config", {});
    w.host.changed();
    await w.ask("scan.start", { rect: { x: 0, y: 0, w: 10, h: 10 } });
    w.host.scanned(`https://192.168.1.20:8443/pair#k1.${KEY}.${CODE_SCANNED}`);
    await settle();
    const typed = await w.ask("hand", { address: "https://192.168.1.20:8443", token: CODE_TYPED });
    await w.ask("hand", { address: "ignored", token: `https://192.168.1.20:8443/pair#k1.${KEY}.${CODE_PASTED}` });
    // A refused probe that repeats what was typed, and a link pasted where the address goes.
    w.conn.probe = (origin) => ({ kind: "refused", reason: refuse("pairBadAddress", `${origin} ${CODE_TYPED}`) });
    await w.ask("hand", { address: "https://192.168.1.20:8443", token: CODE_TYPED });
    await w.ask("hand", { address: `https://192.168.1.20:8443/pair#${CODE_PASTED}`, token: CODE_TYPED });
    w.conn.probe = (origin) => ({ kind: "refused", reason: refuse("pairBadAddress", origin) });
    await w.ask("hand", { address: `https://192.168.1.20:8443/pair#${CODE_PASTED}`, token: "x" });
    // A redeem that is refused in words that repeat the code and the tokens it answered with.
    w.conn.probe = (origin) => ({ kind: "offers", admission: { origin, pin: null, flavor: "selfhost", apiBase: origin, provisionalPin: false, probed: true } });
    const again = await w.ask("hand", { address: "https://mail.example.test", token: CODE_TYPED });
    w.conn.redeem = { ok: false, reason: refuse("pairNotStoredClosed", refuse("verbatimDetail", `could not store ${CODE_TYPED}`)) };
    expect(await w.ask("pair", { ticket: (again as { ticket: string }).ticket }))
      .toEqual({ ok: false, said: { code: "pairNotStoredClosed", args: [{ code: "verbatimDetail", args: [""] }] } });
    void typed;
    // A mailbox opened on this phone, then one refused in words that repeat its password.
    expect(await w.ask("open", { input: INPUT })).toEqual({ ok: true, mailboxId: "engine-account" });
    forgetOrganizerSessionForTests();
    w.conn.adopt = async () => ({ ok: false, reason: refuse("standaloneNotStored", `the keystore said ${PASSWORD}`) });
    expect(await w.ask("open", { input: INPUT })).toEqual({ ok: false, code: "standaloneNotStored", field: null, args: [] });
    // A session refused, a sync failed and a forget left something, each in words of the platform's.
    w.conn.state = { k: "refused", reason: refuse("pairingsUnreadable", "the keystore could not be read") };
    w.conn.syncError = "the round failed";
    w.conn.forgot = { ok: false, reason: refuse("forgetMailRemains", "the store is busy") };
    await w.ask("forget", { id: "row-2", anyway: false });
    w.host.changed();
    await w.ask("config", {});

    expect(w.sent.length).toBeGreaterThan(14);
    expect(w.conn.redeemed.map(([, token]) => token)).toEqual([CODE_TYPED]);
    expect(w.eng.started.map((s) => s.imap.auth.pass)).toEqual([PASSWORD, PASSWORD]);
    const all = w.sent.join("\n");
    const planted = { scanned: CODE_SCANNED, typed: CODE_TYPED, pasted: CODE_PASTED, refresh: REFRESH, password: PASSWORD, key: KEY };
    expect(Object.entries(planted).filter(([, secret]) => all.includes(secret)).map(([name]) => name), "found in a posted message").toEqual([]);
    // And what did cross is there: the sweep read real messages.
    expect(all).toContain("https://192.168.1.20:8443");
    expect(all).toContain("the keystore could not be read");
    expect(lastState(w.events)).toMatchObject({ session: "refused", after: { code: "forgetMailRemains", args: ["the store is busy"] } });
  });

  it("a refused switch, forget, session or sync that quotes a refresh token this phone holds crosses with it withheld", async () => {
    const w = world();
    const ATTEMPT = "refresh-attempt-8Qw3rTz5";
    w.conn.profiles = [profile({}), profile({ id: "row-2", refreshToken: null, refreshAttempt: ATTEMPT })];
    w.conn.switched = { ok: false, reason: refuse("verbatimDetail", `the server answered ${REFRESH}`) };
    expect(await w.ask("switch", { id: "row-1" })).toEqual({ ok: false, said: { code: "verbatimDetail", args: [""] } });
    w.conn.forgot = { ok: false, reason: refuse("forgetMailRemains", `the store said ${ATTEMPT}`) };
    expect(await w.ask("forget", { id: "row-2", anyway: false })).toEqual({ k: "kept", said: { code: "forgetMailRemains", args: [""] } });
    w.conn.state = { k: "refused", reason: refuse("pairingsUnreadable", `the keystore said ${REFRESH}`) };
    w.conn.syncError = `the round failed on ${ATTEMPT}`;
    w.host.changed();
    expect(lastState(w.events)).toMatchObject({
      said: { code: "pairingsUnreadable", args: [""] }, syncSaid: { code: "verbatimDetail", args: [""] }, after: { args: [""] },
    });
    expect([REFRESH, ATTEMPT].filter((token) => w.sent.join("\n").includes(token))).toEqual([]);
  });

  it("a refusal crosses as its key and arguments, bounded: three deep, 512 characters, no secret, no link", () => {
    const deep = refuse("unreachableWhy", refuse("unreachableWhy", refuse("unreachableWhy", refuse("unreachableDns"))));
    expect(said(deep)).toEqual({ code: "unreachableWhy", args: [{ code: "unreachableWhy", args: [{ code: "unreachableWhy", args: [""] }] }] });
    expect(said(refuse("verbatimDetail", "a".repeat(600))).args[0]).toHaveLength(512);
    expect(said(refuse("verbatimDetail", `x ${PASSWORD} y`, 7, true), [PASSWORD]).args).toEqual(["", "7", "true"]);
    expect(said(refuse("pairBadAddress", `https://host.example.test/pair#${CODE_PASTED}`)).args).toEqual([""]);
    expect(said(refuse("verbatimDetail", "kept"), [""]).args, "an empty secret withholds nothing").toEqual(["kept"]);
  });
});

describe("the door's host: a mailbox opened on this phone", () => {
  it("runs the order: the slot, the consent's licence, the engine, the door held, the session of this launch, the adoption, the notice, and in", async () => {
    const w = world();
    expect(await w.ask("open", { input: INPUT })).toEqual({ ok: true, mailboxId: "engine-account" });
    expect(w.log).toEqual(["engine:armed", "session:held:ada@example.test:true", "adopt:held", "notice", "entered"]);
    expect(w.eng.started[0]).toMatchObject({
      address: "ada@example.test", displayName: "Ada", machineName: "ohmail on a phone", installId: "install-1",
      imap: { host: "imap.example.test", port: 993, secure: true, auth: { user: "ada@example.test", pass: PASSWORD }, smtp: { host: "smtp.example.test", port: 465 } },
    });
    expect(takeConsentPress(), "the slot's release takes the licence with it").toBe(false);
  });

  it("refuses a second open while one is in flight, and names the field a refusal is about", async () => {
    const w = world();
    let release = () => {};
    w.conn.adopt = () => new Promise<Attempt>((resolve) => { release = () => resolve({ ok: true }); });
    const first = w.ask("open", { input: INPUT });
    await settle();
    expect(await w.ask("open", { input: INPUT })).toEqual({ ok: false, code: "standaloneAlreadyOpen", field: null, args: [] });
    expect(w.host.busy()).toBe(true);
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(w.host.busy()).toBe(false);
    forgetOrganizerSessionForTests();
    expect(await w.ask("open", { input: { ...INPUT, imap: { host: "", port: 993 } } }))
      .toEqual({ ok: false, code: "standaloneNoHost", field: "imapHost", args: [] });
    expect(await w.ask("open", { input: { ...INPUT, imap: { host: "imap.example.test", port: null } } }))
      .toMatchObject({ ok: false, code: "standaloneNoPort", field: "imapPort" });
  });

  it("gives the slot back on a throw, so the next press is not refused for the run of the app", async () => {
    const w = world();
    // Thrown after the slot was taken and before any door is held: only the slot can refuse the next press.
    w.dials.depsThrow = true;
    expect(await w.post("open", { input: INPUT })).toMatchObject({ ok: false, refused: "unreachable" });
    expect(w.host.busy()).toBe(false);
    w.dials.depsThrow = false;
    expect(await w.ask("open", { input: INPUT })).toEqual({ ok: true, mailboxId: "engine-account" });
  });

  it("says so when the build cannot reach its background half, and still opens the mailbox", async () => {
    const w = world();
    w.dials.sessionFails = true;
    expect(await w.ask("open", { input: INPUT })).toMatchObject({ ok: true });
    await settle();
    expect(organizerRestrictedSaid()).toBe(true);
  });

  it("a refused open crosses as its code and its field alone: native's words, a fault's or a server's, stay native", async () => {
    const w = world();
    w.conn.adopt = async () => ({ ok: false, reason: refuse("standaloneNotStored", "the keystore is held by another app") });
    expect(await w.ask("open", { input: INPUT })).toEqual({ ok: false, code: "standaloneNotStored", field: null, args: [] });
    forgetOrganizerSessionForTests();
    w.conn.adopt = async () => ({ ok: false, reason: refuse("standaloneNotStored", refuse("verbatimDetail", "the server said: try later")) });
    expect(await w.ask("open", { input: INPUT })).toEqual({ ok: false, code: "standaloneNotStored", field: null, args: [] });
  });

  it("withholds the way in a build that cannot organize: told so, and an open is refused before anything is taken", async () => {
    const w = world({ offered: false });
    expect((await w.ask("config", {})).organizes).toBe("withheld");
    expect(await w.ask("open", { input: INPUT })).toEqual({ ok: false, code: "standaloneNoEngine", field: null, args: [] });
    expect(w.eng.started).toEqual([]);
    expect(w.log).toEqual([]);
  });
});

describe("the door's host: the list of servers", () => {
  it("tells the page where it opens and what the connection is, a row at a time and never a credential", async () => {
    const w = world();
    expect(await w.ask("config", {})).toMatchObject({ at: "welcome", organizes: "offered", canPin: true, state: { session: "none", paired: [] } });
    const ended = profile({ id: "row-2", origin: "https://192.168.1.20:8443", flavor: "desktop-host", refreshToken: null, pin: KEY });
    const hosted = profile({ id: "row-3", origin: "https://api.ohmail.app", flavor: "managed" });
    w.conn.profiles = [profile({}), ended, hosted, OWN];
    w.conn.activeId = "row-1";
    const config: DoorConfig = await w.ask("config", {});
    expect(config.at).toBe("servers");
    expect(config.state.paired).toEqual([
      { id: "row-1", kind: "server", address: "https://mail.example.test", account: "account-1", open: true, needsPair: false },
      { id: "row-2", kind: "computer", address: "https://192.168.1.20:8443", account: null, open: false, needsPair: true },
      { id: "row-3", kind: "hosted", address: "https://api.ohmail.app", account: "account-1", open: false, needsPair: false },
      { id: "row-own", kind: "own", address: "", account: null, open: false, needsPair: false },
    ]);
    w.conn.state = shell(profile({ pin: KEY }));
    expect((await w.ask("config", {})).state).toMatchObject({ session: "live", openId: "row-1", pinned: true, total: null });
    w.conn.state = { k: "connecting", origin: "https://mail.example.test" };
    expect((await w.ask("config", {})).state.session).toBe("opening");
    w.conn.state = { k: "ended", reason: refuse("pairEnded") };
    expect((await w.ask("config", {})).state).toMatchObject({ session: "ended", said: { code: "pairEnded", args: [] }, openId: null });
    expect((await world({ asked: "servers" }).ask("config", {})).at, "asked for by the open mailbox's page").toBe("servers");
  });

  it("tells a store's upgrade under a connect as its count and its start, only where the boot screen would count it, and nothing of it once the connect is over", async () => {
    const w = world();
    const origin = "https://mail.example.test";
    const upgrade = (m: StoreMigrating): BootMigrating => ({ ...m, since: 1_700_000_000_000 });
    const told = async (m: BootMigrating | undefined) => {
      w.conn.state = m === undefined ? { k: "connecting", origin } : { k: "connecting", origin, migrating: m };
      w.host.changed();
      const event = lastState(w.events)!;
      expect((await w.ask("config", {})).state.migrating, "the config says what the event says").toEqual(event.migrating);
      expect(event.session).toBe("opening");
      return event.migrating;
    };
    expect(await told(undefined)).toBeNull();
    expect(await told(upgrade({ applied: 3, pending: 12, fresh: false }))).toEqual({ applied: 3, pending: 12, since: 1_700_000_000_000 });
    // The later announcement of the same upgrade keeps the phase's start.
    expect(await told(upgrade({ applied: 11, pending: 12, fresh: false }))).toEqual({ applied: 11, pending: 12, since: 1_700_000_000_000 });
    // A first launch's empty store and a single entry have nothing to count: the boot screen's own rule, row by row.
    for (const m of [
      { applied: 0, pending: 12, fresh: true }, { applied: 0, pending: 1, fresh: false }, { applied: 0, pending: 0, fresh: false },
      { applied: 1, pending: 2, fresh: false }, { applied: 4, pending: 40, fresh: true },
    ])
      expect((await told(upgrade(m))) !== null, JSON.stringify(m)).toBe(bootMigratingLines(upgrade(m), 0).count !== null);
    // Over: a live session, a refusal and an idle phone say none.
    for (const state of [shell(profile({})), { k: "refused", reason: refuse("pairEnded") }, { k: "idle" }] as ConnectionState[]) {
      w.conn.state = state;
      w.host.changed();
      expect(lastState(w.events)!.migrating, state.k).toBeNull();
    }
  });

  it("after a forget of the open pairing the next state holds no row of it, and what could not be taken back stands", async () => {
    const w = world();
    const second = profile({ id: "row-2", accountId: "account-2", origin: "https://other.example.test" });
    w.conn.profiles = [profile({}), second];
    w.conn.state = shell(profile({}));
    w.conn.forget = async () => {
      w.conn.profiles = [second];
      w.conn.state = { k: "idle" };
      return { ok: false, reason: refuse("forgetServerUnreachable") };
    };
    expect(await w.ask("forget", { id: "row-1", anyway: false })).toEqual({ k: "gone", after: { code: "forgetServerUnreachable", args: [] } });
    const state = lastState(w.events)!;
    expect(state).toMatchObject({ session: "none", openId: null, after: { code: "forgetServerUnreachable" } });
    expect(JSON.stringify(state)).not.toMatch(/row-1|account-1|mail\.example\.test/);
    // The next forget's press clears the sentence before it runs.
    w.conn.forget = async () => ({ ok: true });
    expect(await w.ask("forget", { id: "row-2", anyway: false })).toEqual({ k: "gone", after: null });
    expect(w.events.filter((e) => e.type === "state").at(-1)).toMatchObject({ state: { after: null } });
  });

  it("answers a forget by what is left: gone, something kept, or the settings only this phone holds", async () => {
    const w = world();
    w.conn.profiles = [OWN, profile({})];
    w.conn.forgot = { ok: false, reason: refuse("forgetKeystoreRefused", "locked") };
    expect(await w.ask("forget", { id: "row-1", anyway: false })).toEqual({ k: "kept", said: { code: "forgetKeystoreRefused", args: ["locked"] } });
    w.conn.forgot = { ok: false, reason: refuse("forgetClaimStands", 10) };
    expect(await w.ask("forget", { id: "row-own", anyway: true })).toEqual({ k: "gone", after: { code: "forgetClaimStands", args: ["10"] } });
    expect(w.log.at(-1)).toBe("forget:row-own:true");
    w.conn.forgot = { ok: false, reason: refuse("serversStopHereSettingsNewer"), settingsKept: "newer" };
    expect(await w.ask("forget", { id: "row-own", anyway: false })).toEqual({ k: "asks", settings: "newer" });
    // Before a removal: a pairing's letters are on its server; this phone's own mailbox is asked about.
    expect(await w.ask("forget.ask", { id: "row-1" })).toEqual({ drafts: 0, settings: "none" });
    expect(await w.ask("forget.ask", { id: "row-own" })).toEqual({ drafts: null, settings: "unknown" });
  });

  it("switches, syncs, disconnects and opens the system's settings by the connection's own verbs", async () => {
    const w = world();
    expect(await w.ask("switch", { id: "row-2" })).toEqual({ ok: true });
    w.conn.switched = { ok: false, reason: refuse("notPairedHere") };
    expect(await w.ask("switch", { id: "row-9" })).toEqual({ ok: false, said: { code: "notPairedHere", args: [] } });
    await w.ask("sync", {});
    await w.ask("disconnect", {});
    await w.ask("settings.open", { what: "notifications" });
    await w.ask("ready", {});
    expect(w.log).toEqual(["switch:row-2", "switch:row-9", "sync", "wake", "disconnect", "settings:notifications", "ready"]);
  });

  it("a sync stopped by a handshake crosses as which of the two it is, never in the platform's words", async () => {
    const w = world();
    const HANDSHAKE = "javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.";
    w.conn.profiles = [profile({})];
    w.conn.activeId = "row-1";
    w.conn.state = shell(profile({}));
    w.conn.syncError = HANDSHAKE;
    w.host.changed();
    const unpinned = (await w.ask("config", {})).state;
    w.conn.state = shell(profile({ pin: KEY }));
    w.host.changed();
    const pinned = (await w.ask("config", {})).state;
    expect(w.sent.filter((m) => m.includes("SSLHandshakeException") || m.includes("Trust anchor")), "the platform's words crossed").toEqual([]);
    expect(unpinned).toMatchObject({ syncSaid: null, syncStopped: "certificate", pinned: false });
    expect(pinned).toMatchObject({ syncSaid: null, syncStopped: "keyChanged", pinned: true });
    expect(lastState(w.events)).toMatchObject({ syncSaid: null, syncStopped: "keyChanged" });
    // Any other failure says its own words, and nothing stopped.
    w.conn.syncError = "the round failed";
    expect((await w.ask("config", {})).state).toMatchObject({ syncSaid: { code: "verbatimDetail", args: ["the round failed"] }, syncStopped: null });
    w.conn.syncError = null;
    expect((await w.ask("config", {})).state).toMatchObject({ syncSaid: null, syncStopped: null });
  });

  it("leaves over an open mailbox by going back; held at the list it opens what this phone can, its own mailbox first", async () => {
    const w = world();
    w.conn.profiles = [profile({}), OWN];
    w.conn.state = shell(profile({}));
    await w.ask("leave", {});
    expect(w.log).toEqual(["back"]);
    w.conn.state = { k: "idle" };
    expect(await w.host.leave()).toBe("left");
    expect(w.log).toEqual(["back", "switch:row-own", "entered"]);
    w.conn.profiles = [profile({ refreshToken: null })];
    expect(await w.host.leave(), "nothing here can be opened again").toBe("stayed");
    w.conn.profiles = [];
    expect(await w.host.leave(), "the first screen is the way").toBe("stayed");
    w.conn.profiles = [profile({})];
    w.conn.switched = { ok: false, reason: refuse("notPairedHere") };
    expect(await w.host.leave(), "a refused switch keeps the list").toBe("stayed");
  });

  it("asks the page for back, and takes no answer of a page that ended", async () => {
    const w = world();
    const asked = w.host.back();
    const ask = w.events.at(-1) as Extract<DoorEvent, { type: "ask" }>;
    await w.ask("answer", { askId: ask.askId, what: "back", took: true });
    expect(await asked).toBe(true);
    const lost = w.host.back();
    w.begin("e2");
    expect(await lost).toBe(false);
  });

  it("answers no kind of the scoped page, no message of another page, and none from a frame or another origin", async () => {
    const w = world();
    expect(await w.post("http", { scope: "p0", method: "GET", path: "/sync", headers: [], body: null })).toMatchObject({ ok: false, refused: "unknownKind" });
    expect(await w.post("keep", { key: "k", value: "v" })).toMatchObject({ ok: false, refused: "unknownKind" });
    const before = w.sent.length;
    w.host.receive({ epoch: "e0", origin: ORIGIN, mainFrame: true, data: JSON.stringify({ id: 90, epoch: "e0", kind: "config" }) });
    w.host.receive({ epoch: "e1", origin: ORIGIN, mainFrame: false, data: JSON.stringify({ id: 91, epoch: "e1", kind: "config" }) });
    w.host.receive({ epoch: "e1", origin: "https://example.test", mainFrame: true, data: JSON.stringify({ id: 92, epoch: "e1", kind: "config" }) });
    await settle();
    expect(w.sent.length).toBe(before);
  });
});
