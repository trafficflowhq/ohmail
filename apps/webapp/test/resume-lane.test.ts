import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LANE_BOUND_MS,
  LANE_COLD_AFTER_MS,
  LANE_SLOTS,
  createResumeLane,
  type LaneTicket,
  type ResumeLane,
} from "../app/shell/resume-lane";

/**
 * THE RESUME LANE ON ITS OWN: admission order and concurrency, on a fake clock. The real shell's
 * request pattern through it is `resume-burst.test.tsx`.
 */

const START = Date.parse("2026-10-20T08:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Enter a GET; records when it was let through and keeps its ticket. */
function enterAll(lane: ResumeLane, paths: string[], extra: { urgent?: boolean; asked?: boolean; signal?: AbortSignal } = {}) {
  const went: string[] = [];
  const tickets = new Map<string, LaneTicket>();
  const failed: string[] = [];
  const settled = paths.map((path) => {
    const entry = lane.enter({ path, free: false, ...extra });
    if (!(entry instanceof Promise)) {
      went.push(path);
      tickets.set(path, entry);
      return Promise.resolve();
    }
    return entry.then((t) => { went.push(path); tickets.set(path, t); }, () => { failed.push(path); });
  });
  return { went, tickets, failed, settled };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe("the resume lane", () => {
  it("a cold lane: the first read leads alone and the others wait for its answer", async () => {
    const lane = createResumeLane();
    const r = enterAll(lane, ["/hello", "/mailboxes", "/consent"]);
    await flush();
    expect(r.went).toEqual(["/hello"]);
    r.tickets.get("/hello")!.done(true);
    await flush();
    expect(r.went).toEqual(["/hello", "/mailboxes", "/consent"]);
  });

  it("a failed lead releases the queue at once", async () => {
    const lane = createResumeLane();
    const r = enterAll(lane, ["/hello", "/mailboxes"]);
    await flush();
    r.tickets.get("/hello")!.done(false);
    await flush();
    expect(r.went).toEqual(["/hello", "/mailboxes"]);
  });

  it("a hung lead releases the queue at exactly the bound", async () => {
    const lane = createResumeLane();
    const r = enterAll(lane, ["/hello", "/mailboxes"]);
    await vi.advanceTimersByTimeAsync(LANE_BOUND_MS - 1);
    expect(r.went).toEqual(["/hello"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.went).toEqual(["/hello", "/mailboxes"]);
  });

  it(`after the lead, background reads take at most ${LANE_SLOTS - 1} slots; the next goes when one frees, or at the bound`, async () => {
    const lane = createResumeLane();
    const paths = ["/lead", "/a", "/b", "/c", "/d", "/e"];
    const r = enterAll(lane, paths);
    await flush();
    r.tickets.get("/lead")!.done(true);
    await flush();
    expect(r.went).toEqual(["/lead", "/a", "/b", "/c"]);
    r.tickets.get("/a")!.done(true);
    await flush();
    expect(r.went).toEqual(["/lead", "/a", "/b", "/c", "/d"]);
    // Nothing frees another slot: `/e` goes at its own bound, counted from its entry.
    await vi.advanceTimersByTimeAsync(LANE_BOUND_MS - 1);
    expect(r.went).not.toContain("/e");
    await vi.advanceTimersByTimeAsync(1);
    expect(r.went).toContain("/e");
  });

  it(`the ${LANE_SLOTS}th slot is kept for the delta and the ceremony reads: they never wait behind background reads`, async () => {
    const lane = createResumeLane();
    const r = enterAll(lane, ["/lead", "/a", "/b", "/c", "/d"]);
    await flush();
    r.tickets.get("/lead")!.done(true);
    await flush();
    expect(r.went, "the premise: background reads fill their slots, one waits").toEqual(["/lead", "/a", "/b", "/c"]);
    const session = lane.enter({ path: "/auth/session", free: false, urgent: true });
    const ticket = session instanceof Promise ? await session : session;
    expect(ticket).toBeDefined();
    await flush();
    expect(r.went, "a background read took the kept slot").not.toContain("/d");
    // Now all four are taken: the delta waits for a slot like anything else.
    const sync = enterAll(lane, ["/sync"]);
    await flush();
    expect(sync.went).toEqual([]);
    ticket.done(true);
    await flush();
    expect(sync.went).toEqual(["/sync"]);
    expect(r.went).not.toContain("/d");
  });

  it("a read the person asked for passes the cap, and is counted", async () => {
    const lane = createResumeLane();
    const r = enterAll(lane, ["/lead", "/a", "/b", "/c", "/d"]);
    await flush();
    r.tickets.get("/lead")!.done(true);
    await flush();
    const kept = lane.enter({ path: "/auth/session", free: false, urgent: true }) as LaneTicket;
    expect(kept).not.toBeInstanceOf(Promise);
    // Every slot taken, background and kept alike: the person's read still goes, at once.
    const asked = lane.enter({ path: "/messages/m1/body", free: false, asked: true });
    expect(asked).not.toBeInstanceOf(Promise);
    expect((asked as LaneTicket).waited).toBe(false);
    // Counted: with the session read answered, its slot is still the person's read's.
    kept.done(true);
    const next = enterAll(lane, ["/account/access"]);
    await flush();
    expect(next.went).toEqual([]);
    (asked as LaneTicket).done(true);
    await flush();
    expect(next.went).toEqual(["/account/access"]);
    expect(r.went).not.toContain("/d");
  });

  it("a read the person asked for still waits for a cold lead's one answer", async () => {
    const lane = createResumeLane();
    const r = enterAll(lane, ["/lead"]);
    const asked = enterAll(lane, ["/messages/m1/body"], { asked: true });
    await flush();
    expect(asked.went).toEqual([]);
    r.tickets.get("/lead")!.done(true);
    await flush();
    expect(asked.went).toEqual(["/messages/m1/body"]);
  });

  it("positive control: an unlimited lane lets every read through once the lead answers", async () => {
    const lane = createResumeLane({ slots: Number.POSITIVE_INFINITY });
    const paths = ["/lead", "/a", "/b", "/c", "/d", "/e", "/f"];
    const r = enterAll(lane, paths);
    await flush();
    r.tickets.get("/lead")!.done(true);
    await flush();
    expect(r.went).toEqual(paths);
  });

  it("free requests never wait, are not counted, and their answers warm the lane", async () => {
    const lane = createResumeLane();
    const held = enterAll(lane, ["/lead", "/a"]);
    const free = lane.enter({ path: "/messages/x/read", free: true });
    expect(free).not.toBeInstanceOf(Promise);
    await flush();
    expect(held.went).toEqual(["/lead"]);
    // A free answer ends the lead: the API answered, so it is warm.
    (free as LaneTicket).done(true);
    await flush();
    expect(held.went).toEqual(["/lead", "/a"]);
    // Warm now: a later read is not held and leads nothing.
    const later = lane.enter({ path: "/b", free: false });
    expect(later).not.toBeInstanceOf(Promise);
  });

  it("warm, outside a window: reads are not held at all, synchronously", () => {
    const lane = createResumeLane();
    const first = lane.enter({ path: "/hello", free: false }) as LaneTicket;
    first.done(true);
    vi.setSystemTime(START + 15_000);
    const many = Array.from({ length: 8 }, (_, i) => lane.enter({ path: `/r${i}`, free: false }));
    expect(many.every((e) => !(e instanceof Promise))).toBe(true);
  });

  it("the uncontended path answers synchronously, never a promise", () => {
    const lane = createResumeLane();
    const entry = lane.enter({ path: "/hello", free: false });
    expect(entry).not.toBeInstanceOf(Promise);
    expect((entry as LaneTicket).waited).toBe(false);
  });

  it("a return reserves the lead for the delta: a read that came first in the same task waits behind it", async () => {
    const lane = createResumeLane();
    (lane.enter({ path: "/hello", free: false }) as LaneTicket).done(true);
    vi.setSystemTime(START + 2 * 60_000);
    lane.resume();
    const r = enterAll(lane, ["/auth/session", "/sync"]);
    await flush();
    expect(r.went).toEqual(["/sync"]);
    r.tickets.get("/sync")!.done(true);
    await flush();
    expect(r.went).toEqual(["/sync", "/auth/session"]);
  });

  it("a return whose tick sent nothing releases the reservation at once", async () => {
    const lane = createResumeLane();
    const release = lane.resume();
    const r = enterAll(lane, ["/auth/session"]);
    await flush();
    expect(r.went).toEqual([]);
    release();
    await flush();
    expect(r.went).toEqual(["/auth/session"]);
  });

  it("a reservation nobody uses or releases ends at the bound", async () => {
    const lane = createResumeLane();
    lane.resume();
    const r = enterAll(lane, ["/auth/session"]);
    await vi.advanceTimersByTimeAsync(LANE_BOUND_MS - 1);
    expect(r.went).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.went).toEqual(["/auth/session"]);
  });

  it("a page load keeps a cold lane's lead for the session confirm: reads that came first wait for its answer", async () => {
    const lane = createResumeLane();
    lane.confirming();
    const r = enterAll(lane, ["/hello", "/mailboxes"]);
    await flush();
    expect(r.went).toEqual([]);
    const confirm = lane.enter({ path: "/auth/session", free: false, urgent: true });
    expect(confirm, "the confirm takes the lead it was kept").not.toBeInstanceOf(Promise);
    await flush();
    expect(r.went).toEqual([]);
    (confirm as LaneTicket).done(true);
    await flush();
    expect(r.went).toEqual(["/hello", "/mailboxes"]);
  });

  it("the access read never leads a cold lane: it goes at once, counted, and the next read leads", async () => {
    const lane = createResumeLane();
    const access = lane.enter({ path: "/account/access", free: false });
    expect(access, "the access read waited for nothing").not.toBeInstanceOf(Promise);
    const r = enterAll(lane, ["/hello", "/mailboxes"]);
    await flush();
    expect(r.went, "the read after it led, and the one after that waited").toEqual(["/hello"]);
    r.tickets.get("/hello")!.done(true);
    await flush();
    expect(r.went).toEqual(["/hello", "/mailboxes"]);
  });

  it("a confirm kept for a page load does not hold the access read the first-paint gate asks before any confirm", async () => {
    const lane = createResumeLane();
    lane.confirming();
    const access = lane.enter({ path: "/account/access", free: false });
    expect(access).not.toBeInstanceOf(Promise);
    const r = enterAll(lane, ["/hello"]);
    await flush();
    expect(r.went).toEqual([]);
    // Its answer is not the confirm's: the lead stays kept, as a return's stays kept for the delta.
    (access as LaneTicket).done(true);
    await flush();
    expect(r.went).toEqual([]);
    (lane.enter({ path: "/auth/session", free: false, urgent: true }) as LaneTicket).done(true);
    await flush();
    expect(r.went).toEqual(["/hello"]);
  });

  it("a confirm kept for a page load ends at the bound when none comes, and at once when released", async () => {
    const lane = createResumeLane();
    lane.confirming();
    const r = enterAll(lane, ["/hello"]);
    await vi.advanceTimersByTimeAsync(LANE_BOUND_MS - 1);
    expect(r.went).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.went).toEqual(["/hello"]);
    const next = createResumeLane();
    const release = next.confirming();
    const s = enterAll(next, ["/hello"]);
    await flush();
    expect(s.went).toEqual([]);
    release();
    await flush();
    expect(s.went).toEqual(["/hello"]);
  });

  it("a warm lane keeps nothing for the confirm", () => {
    const lane = createResumeLane();
    (lane.enter({ path: "/hello", free: false }) as LaneTicket).done(true);
    lane.confirming();
    expect(lane.enter({ path: "/mailboxes", free: false })).not.toBeInstanceOf(Promise);
  });

  it("afterLead runs once the delta answers, and at once when no lead is in the air", async () => {
    const lane = createResumeLane();
    const ran: string[] = [];
    lane.afterLead(() => ran.push("idle"));
    expect(ran).toEqual(["idle"]);
    lane.resume();
    const sync = lane.enter({ path: "/sync", free: false }) as LaneTicket;
    lane.afterLead(() => ran.push("stream"));
    expect(ran).toEqual(["idle"]);
    sync.done(true);
    expect(ran).toEqual(["idle", "stream"]);
  });

  it("rank order: the delta, then ceremony reads and the access read, then the rest, first come within each", async () => {
    const lane = createResumeLane();
    const lead = lane.enter({ path: "/hello", free: false }) as LaneTicket;
    const order: string[] = [];
    const queued = [
      { path: "/mailboxes" }, { path: "/consent" }, { path: "/account/access" },
      { path: "/auth/session", urgent: true }, { path: "/sync" }, { path: "/screener" },
    ].map((req) => (lane.enter({ ...req, free: false }) as Promise<LaneTicket>).then((t) => { order.push(req.path); return t; }));
    await flush();
    expect(order).toEqual([]);
    lead.done(true);
    await flush();
    // Three in flight: a background read may not take the fourth slot.
    expect(order).toEqual(["/sync", "/account/access", "/auth/session"]);
    (await queued[4]!).done(true);
    (await queued[2]!).done(true);
    await flush();
    expect(order).toEqual(["/sync", "/account/access", "/auth/session", "/mailboxes", "/consent"]);
    (await queued[3]!).done(true);
    await flush();
    expect(order).toEqual(["/sync", "/account/access", "/auth/session", "/mailboxes", "/consent", "/screener"]);
  });

  it("an aborted waiter leaves the queue and fails as its fetch would; the others are not held by it", async () => {
    const lane = createResumeLane({ slots: 1 });
    const lead = lane.enter({ path: "/hello", free: false }) as LaneTicket;
    const ctl = new AbortController();
    const aborted = lane.enter({ path: "/consent", free: false, signal: ctl.signal }) as Promise<LaneTicket>;
    const next = enterAll(lane, ["/mailboxes"]);
    ctl.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    lead.done(true);
    await flush();
    expect(next.went).toEqual(["/mailboxes"]);
  });

  it("a clock stepped back reads as cold, and a held read still goes within the bound", async () => {
    const lane = createResumeLane();
    (lane.enter({ path: "/hello", free: false }) as LaneTicket).done(true);
    vi.setSystemTime(START - 60_000);
    const r = enterAll(lane, ["/a", "/b"]);
    await flush();
    expect(r.went).toEqual(["/a"]);
    await vi.advanceTimersByTimeAsync(LANE_BOUND_MS);
    expect(r.went).toEqual(["/a", "/b"]);
  });

  it(`cold again after ${LANE_COLD_AFTER_MS / 1000} s with no answer`, async () => {
    const lane = createResumeLane();
    (lane.enter({ path: "/hello", free: false }) as LaneTicket).done(true);
    vi.setSystemTime(START + LANE_COLD_AFTER_MS - 1);
    expect(lane.enter({ path: "/a", free: false })).not.toBeInstanceOf(Promise);
    vi.setSystemTime(START + LANE_COLD_AFTER_MS + 20_000);
    const r = enterAll(lane, ["/b", "/c"]);
    await flush();
    expect(r.went).toEqual(["/b"]);
  });
});
