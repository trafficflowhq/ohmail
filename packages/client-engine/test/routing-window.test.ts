import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { FOLDER_OF_VIEW } from "../src/types.js";
import type { StorageDoor } from "../src/durable.js";
import {
  ROUTING_INTENT_IDS_MAX,
  ROUTING_INTENT_TTL_MS,
  routingIntentsKey,
  routingSubject,
  type AnyRoutingIntent,
  type RoutingIntent,
} from "../src/routing-intents.js";
import {
  createRoutingWindow,
  type TabWindows,
} from "../src/routing-window.js";

/**
 * THE ROUTING WINDOW — Move, File and Junk file mail through a plan whose rule half has no wire
 * inverse, so the routing is HELD and the mail moves now. Everything here is counted at the
 * DISPATCH SEAM, never as view state: what reaches the wire, when, and what never does.
 *
 * The press records its INPUTS and the commit RE-PLANS: a journalled `rule_create` would mint a
 * second row under a second idempotency key at the next launch, so the planner is a seam here and
 * the cases below assert WHEN it is asked as carefully as what it answered.
 */

const KEY = routingIntentsKey("acc-1");

const RULE: EngineMutation = {
  kind: "rule_create", ruleKind: "sender", match: "a@b.test", destination: "ohmail/News",
};

function intent(over: Partial<RoutingIntent> = {}): RoutingIntent {
  return {
    v: 1,
    id: "press-1",
    seedId: "m1",
    address: "a@b.test",
    scope: "sender",
    dest: "reads",
    messageIds: ["m1"],
    at: 1_000_000,
    ...over,
  };
}

/** A door over a plain object, so a test can read the jar back and carry it across a boot. */
function jarDoor(jar: Record<string, string>): StorageDoor {
  return {
    get: (k) => jar[k] ?? null,
    set: (k, v) => { jar[k] = v; return "stored"; },
    remove: (k) => { delete jar[k]; return "stored"; },
  };
}

/** A door that refuses every write — a private window, a full quota. */
function refusingDoor(): StorageDoor {
  return { get: () => null, set: () => "lost", remove: () => "lost" };
}

/** The dispatch is a promise; the journal is cleared when it settles. Let the microtasks run. */
const tick = async (): Promise<void> => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

function rig(opts: {
  door?: StorageDoor;
  jar?: Record<string, string>;
  plan?: (i: AnyRoutingIntent) => readonly EngineMutation[];
  windows?: TabWindows;
} = {}) {
  const jar = opts.jar ?? {};
  const sent: EngineMutation[][] = [];
  /** Every moment the planner was ASKED — a press must never ask it, a commit always must. */
  const planned: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const window = createRoutingWindow({
    door: opts.door ?? jarDoor(jar),
    key: KEY,
    windowMs: 8000,
    now: () => 1_000_000,
    plan: (i) => {
      planned.push(i.id);
      return opts.plan ? opts.plan(i) : [RULE];
    },
    dispatch: async (muts) => { sent.push([...muts]); },
    ...(opts.windows ? { windows: opts.windows } : {}),
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h) => { timers.delete(h as unknown as number); },
  });
  const fireAll = (): void => {
    const live = [...timers.values()];
    timers.clear();
    for (const t of live) t.fn();
  };
  return { window, sent, planned, timers, jar, fireAll };
}

const rows = (jar: Record<string, string>): RoutingIntent[] =>
  jar[KEY] ? (JSON.parse(jar[KEY]!) as RoutingIntent[]) : [];

describe("the routing window", () => {
  it("the press writes the intent, plans NOTHING and sends NOTHING", () => {
    const r = rig();
    const out = r.window.open(intent());
    expect(out).toEqual({ held: true, superseded: false });
    expect(r.sent, "a rule reached the wire inside the undo window").toEqual([]);
    expect(r.planned, "the press planned the routing it is supposed to be holding").toEqual([]);
    expect(rows(r.jar).map((x) => x.id)).toEqual(["press-1"]);
    expect(r.window.pending().map((x) => x.id)).toEqual(["press-1"]);
  });

  it("the journal records the press's INPUTS and no mutation — the replay re-plans", () => {
    const r = rig();
    r.window.open(intent());
    const [row] = rows(r.jar);
    expect(Object.keys(row!).sort())
      .toEqual(["address", "at", "dest", "id", "messageIds", "scope", "seedId", "v"]);
    expect(JSON.stringify(row), "a mutation was journalled — a replay would mint a second rule")
      .not.toContain("rule_create");
  });

  it("Undo inside the window: no rule ever reaches the wire, and the row is gone", () => {
    const r = rig();
    r.window.open(intent());
    expect(r.window.undo(routingSubject(intent()))).toBe(true);
    expect(r.sent, "Undo left the routing on the wire").toEqual([]);
    expect(r.planned).toEqual([]);
    expect(rows(r.jar), "a reversed press stays written down and re-commits at the next boot")
      .toEqual([]);
    expect(r.window.pending()).toEqual([]);
    /* And nothing can fire behind it — Undo disarmed the timer in the same act. */
    expect(r.timers.size).toBe(0);
  });

  it("restart re-arms the close at the full window from the offer, one timer, not two", () => {
    const r = rig();
    r.window.open(intent());
    const [first] = [...r.timers.keys()];
    expect(r.window.restart(routingSubject(intent()))).toBe(true);
    expect([...r.timers.keys()], "the press's own timer still stands beside the offer's").not.toContain(first);
    expect([...r.timers.values()].map((t) => t.ms)).toEqual([8000]);
    expect(r.sent).toEqual([]);
    r.fireAll();
    expect(r.sent, "the restarted window did not commit, or committed twice").toEqual([[RULE]]);
  });

  it("restart after the commit answers false and sends nothing more", () => {
    const r = rig();
    r.window.open(intent());
    r.fireAll();
    expect(r.window.restart(routingSubject(intent()))).toBe(false);
    expect(r.timers.size).toBe(0);
    expect(r.sent).toEqual([[RULE]]);
  });

  it("nothing held is not an undo — a subject with no open window claims nothing", () => {
    const r = rig();
    r.window.open(intent());
    expect(r.window.undo("sender:someone-else@b.test")).toBe(false);
    expect(r.window.pending().length, "the wrong subject took the open window with it").toBe(1);
  });

  it("the window closes and the plan is BUILT THERE and goes once", () => {
    const r = rig();
    r.window.open(intent());
    r.fireAll();
    expect(r.planned, "the routing was not re-planned at the commit").toEqual(["press-1"]);
    expect(r.sent).toEqual([[RULE]]);
    expect(r.window.undo(routingSubject(intent())), "the window is closed — nothing is left")
      .toBe(false);
  });

  it("a re-plan that finds the rule already standing dispatches nothing, and says so", () => {
    const r = rig({ plan: () => [] });
    r.window.open(intent());
    r.fireAll();
    expect(r.planned).toEqual(["press-1"]);
    expect(r.sent, "the empty answer is still handed to the caller, once").toEqual([[]]);
  });

  it("a second press on one subject SUPERSEDES the first — one rule, the later one", () => {
    const r = rig({ plan: (i) => [{ ...RULE, destination: FOLDER_OF_VIEW[i.dest] }] });
    r.window.open(intent());
    const out = r.window.open(intent({ id: "press-2", dest: "receipts" }));
    expect(out.superseded).toBe(true);
    expect(rows(r.jar).map((x) => x.id)).toEqual(["press-2"]);
    r.fireAll();
    expect(r.planned, "the superseded press was planned beside its replacement").toEqual(["press-2"]);
    expect(r.sent).toEqual([[{ ...RULE, destination: "ohmail/Receipts" }]]);
  });

  it("two subjects are two windows — a press about one sender leaves the other alone", () => {
    const r = rig();
    r.window.open(intent());
    r.window.open(intent({ id: "press-2", address: "c@d.test", seedId: "m9" }));
    expect(r.window.pending().length).toBe(2);
    expect(r.window.undo(routingSubject(intent()))).toBe(true);
    expect(r.window.pending().map((x) => x.id)).toEqual(["press-2"]);
  });

  it("a jar that refuses the record commits at once and reports that no undo is on offer", () => {
    const r = rig({ door: refusingDoor() });
    const out = r.window.open(intent());
    expect(out.held).toBe(false);
    expect(r.sent).toEqual([[RULE]]);
    expect(r.window.pending()).toEqual([]);
  });

  it("a boot whose window elapsed while the app was closed commits it ONCE; the next boot has nothing", async () => {
    const jar: Record<string, string> = {};
    rig({ jar }).window.open(intent());
    /* The tab dies here: the timer never fires and the row stands. */
    const boot = rig({ jar });
    const seen = await boot.window.replay(1_000_000 + 20_000);
    expect(seen.committed.map((x) => x.id)).toEqual(["press-1"]);
    expect(boot.sent).toEqual([[RULE]]);
    await tick();
    const again = rig({ jar });
    expect((await again.window.replay(1_000_000 + 40_000)).committed).toEqual([]);
    expect(again.sent, "a second boot wrote the same rule a second time").toEqual([]);
  });

  it("a boot inside the window RESUMES it with the time it has left, and Undo still works", async () => {
    const jar: Record<string, string> = {};
    rig({ jar }).window.open(intent());
    const boot = rig({ jar });
    const seen = await boot.window.replay(1_000_000 + 3_000);
    expect(seen.resumed.map((x) => x.id)).toEqual(["press-1"]);
    expect(boot.sent, "a resumed window sent its plan at the boot").toEqual([]);
    const [only] = [...boot.timers.values()];
    expect(only!.ms, "the resume handed back a whole fresh window").toBe(5_000);
    expect(boot.window.undo(routingSubject(intent()))).toBe(true);
    expect(boot.sent).toEqual([]);
  });

  it("an expired intent is REPORTED and swept, never committed in silence", async () => {
    const jar: Record<string, string> = {};
    rig({ jar }).window.open(intent());
    const boot = rig({ jar });
    const seen = await boot.window.replay(1_000_000 + ROUTING_INTENT_TTL_MS + 1);
    expect(seen.expired.map((x) => x.id), "the caller was not handed the dead press to say so")
      .toEqual(["press-1"]);
    expect(boot.sent, "a day-old rule was written into an account that has moved on").toEqual([]);
    expect(rows(jar), "an expired row left in place is re-rejected at every launch for ever")
      .toEqual([]);
  });

  it("a press another TAB is still counting down is skipped, not committed under it", async () => {
    const jar: Record<string, string> = {};
    rig({ jar }).window.open(intent());
    const boot = rig({
      jar,
      windows: tabs({ elsewhere: new Set(["press-1"]) }),
    });
    const seen = await boot.window.replay(1_000_000 + 20_000);
    expect(seen.elsewhere.map((x) => x.id)).toEqual(["press-1"]);
    expect(boot.sent, "the other tab's open window was committed behind its back").toEqual([]);
    expect(rows(jar), "the holder's own record was swept by a tab that did not own it").toHaveLength(1);
  });

  it("a press another tab already RESOLVED is skipped for ever, not only while its window stood", async () => {
    const jar: Record<string, string> = {};
    rig({ jar }).window.open(intent());
    const boot = rig({ jar, windows: tabs({ resolved: new Set(["press-1"]) }) });
    const seen = await boot.window.replay(1_000_000 + 20_000);
    expect(seen.elsewhere.map((x) => x.id)).toEqual(["press-1"]);
    expect(boot.sent).toEqual([]);
  });

  it("the replay ASKS the other tabs before it acts on anything", async () => {
    const asked: string[] = [];
    const boot = rig({ windows: tabs({ onAsk: () => asked.push("asked") }) });
    await boot.window.replay(1_000_000);
    expect(asked, "a claim broadcast after the fact cannot reach a tab that was not yet open")
      .toEqual(["asked"]);
  });

  it("flush commits every open window — leaving a view is not asking for it back", () => {
    const r = rig();
    r.window.open(intent());
    r.window.open(intent({ id: "press-2", address: "c@d.test" }));
    r.window.flush();
    expect(r.sent).toEqual([[RULE], [RULE]]);
    expect(r.window.pending()).toEqual([]);
  });

  it("a row this build cannot read is dropped rather than replayed as a guess", async () => {
    const jar: Record<string, string> = {
      [KEY]: JSON.stringify([
        { ...intent(), v: 2, id: "future" },
        { ...intent(), id: "no-scope", scope: "domain" },
        { ...intent(), id: "good" },
      ]),
    };
    const boot = rig({ jar });
    const seen = await boot.window.replay(1_000_000 + 20_000);
    expect(seen.committed.map((x) => x.id)).toEqual(["good"]);
    expect(boot.sent).toEqual([[RULE]]);
  });

  it("the id list is bounded — a press over a pile costs a placement, never the press", () => {
    const r = rig();
    const many = Array.from({ length: ROUTING_INTENT_IDS_MAX + 40 }, (_, i) => `m${i}`);
    r.window.open(intent({ messageIds: many }));
    expect(rows(r.jar)[0]!.messageIds).toHaveLength(ROUTING_INTENT_IDS_MAX);
  });

  it("with no coordinator to ask, the replay's commit starts inside the call", () => {
    /* The phone replays at launch before its lists paint; an await here let the first frame show
       the mail in the place the press moved it out of. */
    const jar: Record<string, string> = {};
    rig({ jar }).window.open(intent());
    const boot = rig({ jar });
    void boot.window.replay(1_000_000 + 20_000);
    expect(boot.sent, "the commit waited for a microtask nobody needed").toEqual([[RULE]]);
  });
});

/** A coordinator double — the four answers the window asks it for. */
function tabs(opts: {
  elsewhere?: ReadonlySet<string>;
  resolved?: ReadonlySet<string>;
  onAsk?: () => void;
} = {}): TabWindows {
  return {
    serve: () => {},
    claim: () => {},
    release: () => {},
    ask: async () => { opts.onAsk?.(); },
    elsewhere: () => opts.elsewhere ?? new Set<string>(),
    resolved: () => opts.resolved ?? new Set<string>(),
  };
}
