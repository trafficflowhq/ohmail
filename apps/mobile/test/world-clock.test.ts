import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, type EngineAdapter, type SyncChange, type SyncResponse,
} from "@ohmail/client-engine";
import { createProjector, listStamp, type ProjectionInputs, type Projected } from "../src/state/world-projection";
import { SCREENING_UNSUPPLIED, type WorldActions } from "../src/state/live";
import { nextClockEdge, worldClock } from "../src/state/world-clock";

/**
 * THE LISTS FOLLOW THE CLOCK WITH NOTHING ELSE CHANGING. An equal answer re-renders nothing, so the
 * world's clock ticks by itself: a send dying at 09:00 is listed as interrupted by 09:20, an idle
 * phone past midnight stops calling yesterday's 23:40 today, and Receipts' "Today" moves to its
 * day. Driven through the shipped projector and a driver that runs it as the provider does — on the
 * derived stamp and on the clock's tick, with a fresh clock at every run.
 */

const MIN = 60_000;
const ZONE = "Europe/Zurich";

function msg(i: number, dateMs: number, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id: `m${i}`, accountId: "acct", mailboxId: "mb", threadId: `t${i}`, messageIdHeader: null,
    subject: `S${i}`, from: { name: `N${i}`, address: `s${i}@example.test` }, to: [{ name: null, address: "me@example.test" }], cc: [],
    date: new Date(dateMs).toISOString(), folder: "INBOX", snippet: `snip ${i}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: new Date(dateMs).toISOString(), ...over,
  } as EngineMessage;
}
const create = (type: string, id: string, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq: 1, updatedAt: new Date().toISOString(), entity } as SyncChange);
const draft = (id: string, status: string, atMs: number) => ({
  id, mailboxId: "mb", threadId: null, inReplyToMessageId: null, subject: "the only copy", body: "text",
  to: [{ name: null, address: "x@example.test" }], cc: [], bcc: [], rationale: null, status,
  updatedAt: new Date(atMs).toISOString(), createdAt: new Date(atMs).toISOString(),
});

/* The provider's inputs keep their identity between runs, as its state does. */
const OWN = ["me@example.test"] as readonly string[];
const HELD = new Set<string>();
const PLACES = new Map() as never;
const SCOPES = {};
const LEAVING: never[] = [];

/** The provider, renderer-free: a run when the derived stamp or the clock's beat moves, the clock re-armed after each. */
function rig(first: SyncChange[]) {
  const pages: SyncChange[][] = [first];
  let seq = 1000;
  const adapter = {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: pages.shift() ?? [], updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`, hasMore: false, serverTime: new Date().toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), storePolicy: { mode: "full" } });
  const projector = createProjector();
  const inputs = (): ProjectionInputs => ({
    engine, worldKey: "rig", standalone: false, bearer: null, images: "direct" as never, zone: ZONE, locale: "en",
    now: new Date(), foldersOn: false, foldersPending: false, foldersStorable: true, walker: null, searchWalker: null,
    openOffMirror: () => undefined, scopes: SCOPES, leavingWaiting: LEAVING, heldDeletes: HELD, heldPlaces: PLACES,
    ownAddresses: OWN, posture: SCREENING_UNSUPPLIED, actions: {} as WorldActions, onPresented: () => undefined,
    account: () => ({ name: "rig", email: "" }), setFoldersEnabled: async () => true, folderSummary: async () => null,
    rememberResurfaceTime: () => undefined, signatures: null, resurfaceTime: null, screenerServer: null, relayed: null, mailboxes: null,
  } as unknown as ProjectionInputs);
  let beat = 0;
  let last: string | null = null;
  let world: Projected | null = null;
  let runs = 0;
  const clock = worldClock({ edge: () => nextClockEdge(engine.read(), new Date(), ZONE), tick: () => { beat += 1; } });
  const render = (): Projected => {
    const key = `${listStamp(engine)}|${beat}`;
    if (key !== last) {
      last = key; runs += 1;
      world = projector.project(inputs());
      clock.arm();
    }
    return world!;
  };
  const push = (ch: SyncChange[]) => pages.push(ch.map((c) => ({ ...c, seq: seq++ })));
  return { engine, render, push, clock, runs: () => runs, fresh: () => createProjector().project(inputs()) };
}

afterEach(() => { vi.useRealTimers(); });

describe("a send that died mid-flight reaches Drafts as interrupted", () => {
  const t0 = Date.UTC(2026, 8, 29, 6, 0, 0); // 08:00 Zurich
  it("by a re-run twenty minutes later (the run reads its own clock, not the kept view's)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    const r = rig([create("message", "m1", msg(1, t0 - 60 * MIN))]);
    await r.engine.start();
    r.render();
    vi.setSystemTime(t0 + 60 * MIN);
    r.push([create("draft", "d1", draft("d1", "sending", t0 + 60 * MIN))]);
    await r.engine.syncOnce();
    expect(r.render().drafts).toEqual([]);
    vi.setSystemTime(t0 + 80 * MIN);
    r.push([create("message", "m2", msg(2, t0 + 79 * MIN))]);
    await r.engine.syncOnce();
    expect(r.fresh().drafts.map((d) => d.state), "control: a fresh projector lists it").toEqual(["interrupted"]);
    expect(r.render().drafts.map((d) => d.state)).toEqual(["interrupted"]);
  });

  it("with nothing else changing: the clock ticks at the send's threshold", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(t0);
    const r = rig([create("message", "m1", msg(1, t0 - 60 * MIN))]);
    await r.engine.start();
    r.render();
    vi.setSystemTime(t0 + 60 * MIN);
    r.push([create("draft", "d1", draft("d1", "sending", t0 + 60 * MIN))]);
    await r.engine.syncOnce();
    expect(r.render().drafts).toEqual([]);
    const runs = r.runs();
    vi.advanceTimersByTime(9 * MIN);
    expect(r.render().drafts, "listed before its ten minutes").toEqual([]);
    vi.advanceTimersByTime(2 * MIN);
    expect(r.render().drafts.map((d) => d.state), "no tick at the threshold").toEqual(["interrupted"]);
    expect(r.runs() - runs).toBe(1);
  });

  it("a held send stops reading 'checking' a day after it was left, with nothing else changing", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(t0);
    const r = rig([create("draft", "d2", draft("d2", "unverified", t0))]);
    await r.engine.start();
    expect(r.render().drafts.map((d) => d.heldSays)).toEqual(["checking"]);
    vi.advanceTimersByTime(24 * 60 * MIN + MIN);
    expect(r.render().drafts.map((d) => d.heldSays)).toEqual(["notInSent"]);
  });
});

describe("midnight on an idle phone", () => {
  const LATE = Date.UTC(2026, 8, 29, 21, 50, 0); // 23:50 Zurich
  it("yesterday's 23:40 stops reading as today's clock, with no mailbox change", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(LATE);
    const r = rig([create("message", "m1", msg(1, LATE - 10 * MIN))]);
    await r.engine.start();
    expect(r.render().screener.waiting[0]!.time).toBe("23:40");
    vi.advanceTimersByTime(30 * MIN);
    const control = r.fresh().screener.waiting[0]!.time;
    expect(control, "control: a fresh projector names the day").not.toBe("23:40");
    expect(r.render().screener.waiting[0]!.time).toBe(control);
  });

  it("Receipts' Today group becomes its day", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(LATE);
    const r = rig([create("message", "m1", msg(1, LATE - 10 * MIN, { folder: "ohmail/Receipts" }))]);
    await r.engine.start();
    const today = r.render().receipts.groups[0]?.label;
    expect(today, "the fixture has no receipt: the arm measures nothing").toBeTruthy();
    vi.advanceTimersByTime(30 * MIN);
    const control = r.fresh().receipts.groups[0]!.label;
    expect(control).not.toBe(today);
    expect(r.render().receipts.groups[0]!.label).toBe(control);
  });
});

describe("the edge and the timer", () => {
  it("the next edge is the zone's next midnight, or a send's threshold when that comes first", async () => {
    const at = new Date(Date.UTC(2026, 8, 29, 10, 0, 0)); // 12:00 Zurich
    const r = rig([]);
    await r.engine.start();
    expect(nextClockEdge(r.engine.read(), at, ZONE)).toBe(Date.UTC(2026, 8, 29, 22, 0, 0));
    expect(nextClockEdge(r.engine.read(), at, "America/New_York")).toBe(Date.UTC(2026, 8, 30, 4, 0, 0));
    // The night the clocks go back in Zurich: midnight is still 23:00 UTC before.
    expect(nextClockEdge(r.engine.read(), new Date(Date.UTC(2026, 9, 24, 12)), ZONE)).toBe(Date.UTC(2026, 9, 24, 22, 0, 0));
    expect(nextClockEdge(r.engine.read(), new Date(Date.UTC(2026, 9, 25, 12)), ZONE)).toBe(Date.UTC(2026, 9, 25, 23, 0, 0));
  });

  it("a resume after the edge ticks at once; before it, it only re-arms", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    let ticks = 0;
    const c = worldClock({ edge: () => 10 * MIN, tick: () => { ticks += 1; } });
    c.arm();
    vi.setSystemTime(5 * MIN);
    c.resume();
    expect(ticks).toBe(0);
    vi.setSystemTime(11 * MIN); // asleep past the edge: the timer did not fire
    c.resume();
    expect(ticks).toBe(1);
    c.stop();
  });
});
