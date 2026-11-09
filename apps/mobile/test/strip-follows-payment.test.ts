/**
 * THE PHONE'S STRIP FOLLOWS THE PAYMENT: a person who has just paid never
 * reads a trial or payment strip again. The door and its feed are driven for real; the component
 * has no renderer here, so it is held by a census over its source.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  accessFeedFor, forgetAccessFeed, onAccessFeed, putAwayCatchUp, readAccess, resetAccessFeedForTests,
} from "../src/net/account";
import { resetAccessLockForTests } from "../src/net/access-lock";
import type { AppLifecycle, CadenceTimers } from "../src/net/drain-cadence";
import type { ConnectedSession } from "../src/net/pairing";
import {
  QUIET_RETURN_MS, resetDismissalsForTests, settlesTheStrip, stripLineKey, stripNotice, stripPress,
} from "../src/ui/lifecycle-strip";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { RETURN_DEBOUNCE_MS, wallLift } from "../src/ui/wall-lift";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.join(HERE, "..", rel), "utf8");

const PAID = { metered: true, access: "open", canAddMailbox: true, mailboxes: 2, aiEnabled: true,
  lifecycle: { state: "active", closedReason: null } };
const GRACE = { ...PAID, lifecycle: { state: "grace", closedReason: null, graceUntil: "2026-10-01T09:00:00.000Z" } };
const SINCE = "2026-09-23T02:15:07.000Z";

/** A paired Cloud session whose door answers what the case says, counting every request. */
function session(answer: () => unknown | null, id = "pairing-1") {
  let n = 0;
  const s = {
    standalone: false,
    ownerKey: `owner-${id}`,
    profile: { id, origin: "https://cloud.test", apiBase: null, flavor: "managed" },
    fetch: async () => {
      n += 1;
      const body = answer();
      return body === null
        ? new Response("unavailable", { status: 503 })
        : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  } as unknown as ConnectedSession;
  return { s, reads: () => n };
}

let clock = Date.parse("2026-09-28T08:00:00.000Z");
beforeEach(() => {
  resetAccessLockForTests();
  resetAccessFeedForTests();
  resetDismissalsForTests();
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
const later = (ms: number): void => { clock += ms; };

describe("the door joins a return, per session", () => {
  it("a read inside the debounce is the same request; after it, a new one", async () => {
    const { s, reads } = session(() => PAID);
    await readAccess(s);
    later(RETURN_DEBOUNCE_MS - 1);
    await readAccess(s);
    expect(reads()).toBe(1);
    later(2);
    await readAccess(s);
    expect(reads()).toBe(2);
  });

  it("a failed read is not joined", async () => {
    let body: unknown | null = null;
    const { s, reads } = session(() => body);
    expect(await readAccess(s)).toBeNull();
    body = PAID;
    expect((await readAccess(s))?.metered).toBe(true);
    expect(reads()).toBe(2);
  });
});

describe("the feed", () => {
  it("every answer moves it: a paid answer earns no strip", async () => {
    let body: unknown = GRACE;
    const { s } = session(() => body);
    await readAccess(s);
    expect(stripNotice(accessFeedFor("pairing-1"), s.ownerKey ?? null, new Set(), clock)?.kind).toBe("grace");
    body = PAID;
    later(60_000);
    await readAccess(s);
    expect(stripNotice(accessFeedFor("pairing-1"), s.ownerKey ?? null, new Set(), clock)).toBeNull();
  });

  it("KEEPS THE CATCH-UP the wall's lift read was handed, until it is put away", async () => {
    let body: unknown = { ...PAID, caughtUp: { since: SINCE } };
    const { s } = session(() => body);
    await readAccess(s); // the wall's lift: the door answers the catch-up once
    body = PAID;
    later(60_000);
    await readAccess(s); // the strip's own read, which the door answers without it
    expect(stripNotice(accessFeedFor("pairing-1"), s.ownerKey ?? null, new Set(), clock))
      .toEqual({ kind: "caughtUp", since: SINCE });
    putAwayCatchUp("pairing-1");
    later(60_000);
    await readAccess(s);
    expect(stripNotice(accessFeedFor("pairing-1"), s.ownerKey ?? null, new Set(), clock), "never said twice").toBeNull();
  });

  it("is per pairing, and forgetting a pairing forgets its entry", async () => {
    const a = session(() => GRACE, "pairing-a");
    await readAccess(a.s);
    expect(accessFeedFor("pairing-b")).toBeNull();
    let told = 0;
    const off = onAccessFeed(() => { told += 1; });
    forgetAccessFeed("pairing-a");
    off();
    expect(accessFeedFor("pairing-a")).toBeNull();
    expect(told).toBe(1);
    expect(read("src/net/pairing.ts")).toMatch(/export async function forgetProfile[\s\S]*?forgetAccessFeed\(profileId\);/);
  });

  it("the snapshot is the stored reference until the next answer", async () => {
    const { s } = session(() => PAID);
    await readAccess(s);
    expect(accessFeedFor("pairing-1")).toBe(accessFeedFor("pairing-1"));
  });

  it("settles the strip's poll on an answer with no deadline", () => {
    expect(settlesTheStrip({ metered: false }, clock)).toBe(true);
    expect(settlesTheStrip(PAID as never, clock)).toBe(true);
    expect(settlesTheStrip(GRACE as never, clock)).toBe(false);
  });
});

/* The drain cadence's own hand-driven clock and lifecycle, as the wall's suite drives them. */
function handClock() {
  let seq = 0;
  let at = 0;
  const due = new Map<number, { when: number; fn: () => void }>();
  const timers: CadenceTimers = {
    set: (fn, ms) => { seq += 1; due.set(seq, { when: at + ms, fn }); return seq; },
    clear: (handle) => { due.delete(handle as number); },
  };
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  return {
    timers, now: () => at, armed: () => due.size, flush,
    advance: async (ms: number): Promise<void> => {
      const end = at + ms;
      await flush();
      for (;;) {
        const next = [...due.entries()].filter(([, d]) => d.when <= end).sort((x, y) => x[1].when - y[1].when)[0];
        if (next === undefined) break;
        due.delete(next[0]);
        at = next[1].when;
        next[1].fn();
        await flush();
      }
      at = end;
      await flush();
    },
  };
}
function lifecycle() {
  let status = "active";
  const listeners = new Set<(s: string) => void>();
  const source: AppLifecycle = {
    now: () => status,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return { source, move: (next: string) => { status = next; for (const l of listeners) l(next); } };
}

describe("the strip's schedule", () => {
  function rig(drawn: boolean, lastAsked = 0) {
    const c = handClock();
    const life = lifecycle();
    let reads = 0;
    const machine = wallLift({
      opens: async () => { reads += 1; return false; },
      lifecycle: life.source, onCheck: () => undefined, timers: c.timers, now: c.now,
      minute: null,
      returnFloor: () => (drawn ? RETURN_DEBOUNCE_MS : QUIET_RETURN_MS),
      lastAsked: () => lastAsked,
    });
    const back = async (): Promise<void> => { life.move("background"); life.move("active"); await c.flush(); };
    return { c, machine, back, reads: () => reads };
  }

  it("NO CLOCK: a whole day in front asks nothing and arms no timer", async () => {
    const r = rig(true);
    await r.c.advance(24 * 60 * 60_000);
    expect(r.reads()).toBe(0);
    expect(r.c.armed()).toBe(0);
    r.machine.stop();
  });

  it("while a strip is drawn: one read per return, three cycles inside the debounce are one", async () => {
    const r = rig(true);
    await r.c.advance(60_000);
    await r.back();
    await r.back();
    await r.back();
    expect(r.reads()).toBe(1);
    r.machine.stop();
  });

  it("while nothing is drawn: nothing inside fifteen minutes of the last answer, one after", async () => {
    const r = rig(false, 0);
    await r.c.advance(QUIET_RETURN_MS - 1_000);
    await r.back();
    await r.back();
    await r.back();
    expect(r.reads(), "three returns inside the floor").toBe(0);
    await r.c.advance(2_000);
    await r.back();
    expect(r.reads()).toBe(1);
    r.machine.stop();
  });
});

describe("the strip as shipped (source census)", () => {
  const strip = read("src/ui/LifecycleStrip.tsx");

  it("draws from the feed and asks on the return, with no clock", () => {
    expect(strip).toContain("useSyncExternalStore(onAccessFeed, feedOf, feedOf)");
    expect(strip).toMatch(/wallLift\(\{[\s\S]*?minute: null,/);
    expect(strip).toContain("lifecycle: appLifecycle");
    expect(strip).not.toMatch(/void readAccess\(session\)\.then/);
  });

  it("asks nothing on the standalone door", () => {
    expect(strip).toMatch(/useEffect\(\(\) => \{\s*if \(session === null \|\| session\.standalone\) return;/);
  });

  it("the Subscribe press arms the hand-off poll and draws the wall's minting face", () => {
    expect(strip).toMatch(/if \(link\.kind === "url"\) \{\s*lift\.current\?\.armPoll\(\);/);
    expect(strip).toMatch(/minting \? \(\s*<ActivityIndicator/);
  });

  it("the wall names its minute; the default is no clock", () => {
    expect(read("src/ui/AccountWall.tsx")).toMatch(/wallLift\(\{[\s\S]*?minute: WALL_READ_MS,/);
    expect(read("src/ui/wall-lift.ts")).toContain("const every = i.minute ?? null;");
  });
});

/* THE STRIP OFFERS THE PRESS THAT PAYS on every open account: `GET /account/access` names no
   account-page link on its open arm, so the press is decided from the notice and the build's face.
   The open answers below are that arm's own shape. */
const OPEN_TRIAL = {
  metered: true, access: "open", canAddMailbox: true, mailboxes: 2, aiEnabled: true,
  lifecycle: { state: "trialing", closedReason: null, trialEndsAt: "2026-09-29T20:00:00.000Z" },
  exportPath: "/account/export",
};
const OPEN_GRACE = { ...OPEN_TRIAL, lifecycle: { state: "grace", closedReason: null, graceUntil: "2026-10-01T09:00:00.000Z" } };
const OPEN_PAST_DUE = { ...OPEN_TRIAL, lifecycle: { state: "past_due", closedReason: null, graceUntil: "2026-10-01T09:00:00.000Z" } };

describe("the strip's press", () => {
  it("is decided by the notice and the face: the table", () => {
    const deadline = "2026-10-01T09:00:00.000Z";
    const sideload = (kind: "grace" | "pastDue" | "trialEnding") => stripPress({ kind, deadline }, "sideload");
    expect(sideload("trialEnding")).toBe("subscribe");
    expect(sideload("grace")).toBe("subscribe");
    expect(sideload("pastDue")).toBe("fixPayment");
    expect(stripPress({ kind: "caughtUp", since: SINCE }, "sideload")).toBeNull();
    for (const kind of ["trialEnding", "grace", "pastDue"] as const) {
      expect(stripPress({ kind, deadline }, "store"), `store face, ${kind}`).toBeNull();
    }
    expect(stripPress({ kind: "caughtUp", since: SINCE }, "store")).toBeNull();
  });

  for (const [name, body, want] of [
    ["trial", OPEN_TRIAL, "subscribe"], ["grace", OPEN_GRACE, "subscribe"], ["past due", OPEN_PAST_DUE, "fixPayment"],
  ] as const) {
    it(`an OPEN ${name} answer draws the strip and its press on the sideload face, none on the store face`, async () => {
      const { s } = session(() => body);
      await readAccess(s);
      const entry = accessFeedFor("pairing-1");
      expect(entry?.answer.manageUrl, "the open arm names no link").toBeUndefined();
      const notice = stripNotice(entry, s.ownerKey ?? null, new Set(), clock, "sideload");
      expect(notice, "a strip is drawn").not.toBeNull();
      expect(stripPress(notice!, "sideload")).toBe(want);
      expect(stripPress(notice!, "store")).toBeNull();
    });
  }

  it("the store face says no trial end and no 'fix it': a grace and a failed payment state when organizing stops", async () => {
    const { s } = session(() => OPEN_TRIAL);
    await readAccess(s);
    const entry = accessFeedFor("pairing-1");
    expect(stripNotice(entry, s.ownerKey ?? null, new Set(), clock, "store"), "a trial's end is a pointer to buying").toBeNull();
    expect(stripNotice(entry, s.ownerKey ?? null, new Set(), clock), "the shipped build is the store face").toBeNull();
    const deadline = "2026-10-01T09:00:00.000Z";
    expect(stripLineKey({ kind: "pastDue", deadline }, "store")).toBe("stripPaymentFailedPlain");
    expect(stripLineKey({ kind: "grace", deadline }, "store")).toBe("stripGraceEnds");
    expect(stripLineKey({ kind: "pastDue", deadline }, "sideload")).toBe("stripPaymentFailed");
    expect(stripLineKey({ kind: "trialEnding", deadline }, "sideload")).toBe("stripTrialEnds");
    expect(EN.stripPaymentFailedPlain("October 1")).toBe("Your last payment failed. ohmail keeps organizing until October 1.");
    expect(DE.stripPaymentFailedPlain("1. Oktober")).toBe("Deine letzte Zahlung ist fehlgeschlagen. ohmail organisiert noch bis zum 1. Oktober.");
  });

  it("a failed first read publishes nothing, and the next return to the foreground asks again", async () => {
    let fail = true;
    const { s, reads } = session(() => (fail ? null : OPEN_TRIAL));
    const r = handClock();
    const life = lifecycle();
    // The strip's own first paint and schedule, as `LifecycleStrip.tsx` mounts them.
    await readAccess(s);
    const machine = wallLift({
      opens: async () => { const a = await readAccess(s); return a !== null && settlesTheStrip(a, Date.now()); },
      lifecycle: life.source, onCheck: () => undefined, timers: r.timers, now: () => clock,
      minute: null,
      returnFloor: () => QUIET_RETURN_MS,
      lastAsked: () => accessFeedFor("pairing-1")?.at ?? Number.NEGATIVE_INFINITY,
    });
    expect(reads(), "the first paint asked once").toBe(1);
    expect(accessFeedFor("pairing-1"), "a failed read publishes nothing").toBeNull();
    fail = false;
    // Inside the door's join window: only a failed read that was let go can be asked again here.
    later(500);
    life.move("background");
    life.move("active");
    await r.flush();
    await r.flush();
    expect(reads(), "the return asked again").toBe(2);
    expect(stripNotice(accessFeedFor("pairing-1"), s.ownerKey ?? null, new Set(), clock, "sideload")?.kind).toBe("trialEnding");
    machine.stop();
  });
});

describe("the strip's press as shipped (source census)", () => {
  const code = withoutComments(read("src/ui/LifecycleStrip.tsx"));

  it("renders the press stripPress answers, and reads no account-page link", () => {
    expect(code).toContain("const press = stripPress(notice);");
    expect(code).toMatch(/\{press !== null \? \(/);
    expect(code).toContain('label={press === "fixPayment" ? Copy.stripFixPayment : Copy.stripSubscribe}');
    expect(code, "the press is gated on the answer's link again").not.toContain("manageUrl");
    expect(code, "the face is decided outside stripPress again").not.toContain("linksOutToBilling");
  });
});
