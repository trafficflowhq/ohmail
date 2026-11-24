/**
 * THE DOOR'S TICKETS. One live ticket, taken once, by the page it was offered to, inside five minutes. Every other end
 * of a ticket gives back the key its probe installed, through the pairing's own `discardAdmission` over a pin
 * registry double: a key nobody agreed to is read gone, and a stored pairing's key is left alone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { installPinning, type PinningNative } from "../src/net/host-pinning";
import { discardAdmission, type PairAdmission } from "../src/net/pairing";
import { TICKET_SHAPE } from "../src/shell/door-kinds";
import { DoorTickets, TICKET_LIFE_MS } from "../src/shell/door-tickets";

const ORIGIN = "https://192.168.1.20:8443";
const KEY = "A".repeat(43);

function registry() {
  const pins = new Map<string, string>();
  const native: PinningNative = {
    isInstalled: () => true,
    factoryUses: () => 1,
    setPin: (host, port, spki) => pins.set(`${host}:${port}`, spki).size,
    clearPin: (host, port) => (pins.delete(`${host}:${port}`), pins.size),
    clearAllPins: () => (pins.clear(), 0),
    pinnedCount: () => pins.size,
  };
  installPinning(native);
  // What a probe does before it dials: the code's key is installed.
  native.setPin("192.168.1.20", 8443, KEY);
  return pins;
}

const admission = (provisionalPin: boolean): PairAdmission => ({
  origin: ORIGIN, pin: KEY, flavor: "desktop-host", apiBase: ORIGIN, provisionalPin, probed: true,
});

function tickets() {
  let n = 0;
  const clock = { now: 1_000, epoch: "e1", timers: [] as { at: number; fn: () => void; live: boolean }[] };
  const made = new DoorTickets({
    mint: () => (n += 1).toString(16).padStart(32, "0"),
    now: () => clock.now,
    epoch: () => clock.epoch,
    discard: discardAdmission,
    later: (fn, ms) => {
      const timer = { at: clock.now + ms, fn, live: true };
      clock.timers.push(timer);
      return () => { timer.live = false; };
    },
  });
  const pass = (ms: number) => {
    clock.now += ms;
    for (const t of clock.timers) if (t.live && t.at <= clock.now) { t.live = false; t.fn(); }
  };
  return { made, clock, pass };
}

afterEach(() => installPinning(null));

describe("the door's tickets", () => {
  it("offers 16 bytes as hex, and holds nothing under a generator that gives anything else", () => {
    const pins = registry();
    const { made } = tickets();
    expect(made.offer(admission(true), "code-1")).toMatch(TICKET_SHAPE);
    const weak = new DoorTickets({ mint: () => "1234", now: () => 0, epoch: () => "e1", discard: discardAdmission, later: () => () => {} });
    expect(() => weak.offer(admission(true), "code-2")).toThrow(/16 bytes/);
    expect(weak.take("1234")).toBeNull();
    expect(pins.size).toBe(0);
  });

  it("gives the key back when the generator throws, and passes the throw on", () => {
    const pins = registry();
    const broken = new DoorTickets({
      mint: () => { throw new Error("no random bytes"); },
      now: () => 0, epoch: () => "e1", discard: discardAdmission, later: () => () => {},
    });
    expect(() => broken.offer(admission(true), "code-1")).toThrow(/no random bytes/);
    expect(pins.size).toBe(0);
  });

  it("is taken once: the second take gets nothing, and the first leaves the key to the redeem", () => {
    const pins = registry();
    const { made } = tickets();
    const ticket = made.offer(admission(true), "code-1");
    expect(made.take(ticket)).toEqual({ admission: admission(true), token: "code-1" });
    expect(made.take(ticket)).toBeNull();
    expect(pins.size).toBe(1);
  });

  it("takes nothing with no ticket, with a ticket that is not the live one, too late, or from another page", () => {
    const pins = registry();
    const { made, clock, pass } = tickets();
    expect(made.take("0".repeat(32))).toBeNull();

    const first = made.offer(admission(true), "code-1");
    expect(made.take("f".repeat(32))).toBeNull();
    expect(pins.size, "a ticket that is not the live one ends nothing").toBe(1);
    expect(made.take(first)).not.toBeNull();

    const late = made.offer(admission(true), "code-2");
    clock.now += TICKET_LIFE_MS + 1;
    expect(made.take(late)).toBeNull();
    expect(pins.size, "a ticket asked for too late gives its key back").toBe(0);

    pins.set("192.168.1.20:8443", KEY);
    const other = made.offer(admission(true), "code-3");
    clock.epoch = "e2";
    expect(made.take(other)).toBeNull();
    expect(pins.size, "a ticket asked for by another page gives its key back").toBe(0);
    clock.epoch = "e1";
    expect(made.take(other), "and it is gone for the page it was offered to as well").toBeNull();
    void pass;
  });

  it("gives the key back at a dismiss, a page end, a new offer and the five minutes passing; never after a take", () => {
    const pins = registry();
    const { made, pass } = tickets();
    const ends: [string, (ticket: string) => void][] = [
      ["a dismiss", (ticket) => made.drop(ticket)],
      ["a page end", () => made.dropAll()],
      ["a new offer", () => { made.take(made.offer(admission(false), "code-next")); }],
      ["five minutes", () => pass(TICKET_LIFE_MS)],
    ];
    for (const [name, end] of ends) {
      pins.set("192.168.1.20:8443", KEY);
      const ticket = made.offer(admission(true), "code-1");
      end(ticket);
      expect(pins.size, name).toBe(0);
      expect(made.take(ticket), `${name}: the code is let go`).toBeNull();
    }
    pins.set("192.168.1.20:8443", KEY);
    const taken = made.offer(admission(true), "code-1");
    expect(made.take(taken)).not.toBeNull();
    pass(TICKET_LIFE_MS);
    made.drop(taken);
    made.dropAll();
    expect(pins.size, "a taken ticket's key is the redeem's to keep or give back").toBe(1);
  });

  it("leaves a stored pairing's own key alone at every end", () => {
    const pins = registry();
    const { made, pass } = tickets();
    const ticket = made.offer(admission(false), "code-1");
    made.drop(ticket);
    made.offer(admission(false), "code-2");
    pass(TICKET_LIFE_MS);
    made.offer(admission(false), "code-3");
    made.dropAll();
    expect(pins.size).toBe(1);
  });
});
